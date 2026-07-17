import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
// SSE is deprecated in the spec but still what many deployed servers speak;
// a wrapper has to meet servers where they are.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Agent, fetch as undiciFetch } from 'undici';

import {
  type RemoteServerConfig,
  type StdioServerConfig,
  type WrapperConfig,
} from '../schemas/wrapper-config.js';
import { resolveInputType } from './input-type.js';
import {
  collectSecretReferences,
  resolveRemoteTemplates,
  resolveStdioTemplates,
} from './placeholders.js';
import {
  type SecretField,
  type SecretRequestService,
  type SecretResolution,
} from './secret-request-service.js';
import { type SecretVault } from './secret-vault.js';

/** Joins a server name and a tool name into the namespaced tool the wrapper
 * exposes. Server names cannot contain underscores, so the split-back on the
 * first `__` is unambiguous. */
export const TOOL_SEPARATOR = '__';

export type ChildState = 'stopped' | 'starting' | 'running' | 'error';

export interface ChildStatus {
  name: string;
  state: ChildState;
  transport: 'stdio' | 'http' | 'https' | 'sse';
  autoStart: boolean;
  /** Names (never values) of secrets still missing from the vault. */
  missingSecrets: string[];
  /** Live sign-in URL when a prompt is pending for this server. */
  signInUrl?: string;
  toolCount?: number;
  lastError?: string;
}

export interface ChildToolInfo {
  serverName: string;
  /** The namespaced name exposed to the wrapper's client. */
  name: string;
  description?: string;
  inputSchema: unknown;
}

export type StartResult =
  | Readonly<{ ok: true; serverName: string; tools: string[]; alreadyRunning: boolean }>
  | Readonly<{ ok: false; code: 'SECRETS_REQUIRED'; url: string; message: string }>;

export interface ChildServerManager {
  /** Configured server names in declaration order. */
  names: () => string[];
  status: () => ChildStatus[];
  /** Start a server, prompting for missing secrets first. */
  ensureStarted: (name: string) => Promise<StartResult>;
  stop: (name: string) => Promise<boolean>;
  stopAll: () => Promise<void>;
  /** Namespaced tools of every running child. */
  listTools: () => ChildToolInfo[];
  /** Forward a namespaced tool call to the owning child. */
  callTool: (namespacedName: string, args: Record<string, unknown> | undefined) => Promise<unknown>;
}

export type ChildServerManagerDeps = Readonly<{
  config: WrapperConfig;
  vault: SecretVault;
  secretRequests: SecretRequestService;
  /** Invoked whenever the set of proxied tools changes (start/stop). */
  onToolsChanged?: () => void;
  clientVersion?: string;
}>;

interface ChildRuntime {
  state: ChildState;
  client?: Client;
  tools?: { name: string; description?: string | undefined; inputSchema: unknown }[];
  startPromise?: Promise<StartResult>;
  signInUrl?: string;
  lastError?: string;
}

function trace(message: string): void {
  process.stderr.write(`[secure-env] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove every secret VALUE from a message before it can reach stderr, the
 * status output, or an error surfaced to the MCP client. Underlying fetch and
 * SDK errors embed the request URL (and sometimes the upstream response
 * body), either of which may carry resolved `${secure:…}` values — plain or
 * percent-encoded.
 */
function redactSecrets(message: string, values: readonly string[]): string {
  return values
    .filter((value) => value.length > 0)
    .reduce(
      (out, value) =>
        out.split(value).join('[secret]').split(encodeURIComponent(value)).join('[secret]'),
      message,
    );
}

export function createChildServerManager(deps: ChildServerManagerDeps): ChildServerManager {
  const { config, vault, secretRequests } = deps;
  const runtimes = new Map<string, ChildRuntime>();
  for (const name of Object.keys(config.servers)) {
    runtimes.set(name, { state: 'stopped' });
  }

  // Shared dispatcher for servers with `insecureTls`; closed on stopAll.
  let insecureDispatcher: Agent | undefined;
  const insecureFetch = (): FetchLike => {
    insecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false } });
    const dispatcher = insecureDispatcher;
    return ((url: string | URL, init?: RequestInit) =>
      undiciFetch(url, { ...init, dispatcher })) as unknown as FetchLike;
  };

  const runtime = (name: string): ChildRuntime => {
    const entry = runtimes.get(name);
    if (entry === undefined) {
      throw new Error(
        `Unknown server '${name}'. Configured servers: ${Object.keys(config.servers).join(', ')}`,
      );
    }

    return entry;
  };

  const secretNamesFor = (name: string): string[] => {
    const server = config.servers[name];
    return server === undefined
      ? []
      : collectSecretReferences(server).map((reference) => reference.name);
  };

  /** The revealed secret values for a server, for redaction. Empty when some
   * are missing (nothing revealed — and then nothing can leak either). */
  const secretValuesFor = (name: string): string[] => {
    const names = secretNamesFor(name);
    if (vault.missing(names).length > 0) {
      return [];
    }

    return Object.values(vault.reveal(names));
  };

  const secretFieldsFor = (name: string): SecretField[] => {
    const server = config.servers[name];
    if (server === undefined) {
      return [];
    }

    return collectSecretReferences(server).map((reference) => {
      const meta = config.secrets[reference.name];
      const field: SecretField = {
        name: reference.name,
        input: resolveInputType(reference.name, reference.input, meta),
      };
      return meta?.description === undefined ? field : { ...field, description: meta.description };
    });
  };

  const notifyToolsChanged = (): void => {
    deps.onToolsChanged?.();
  };

  const newClient = (): Client =>
    new Client(
      { name: 'mcp-secure-env-elicit', version: deps.clientVersion ?? '0.0.0' },
      { capabilities: {} },
    );

  /** Connect a fresh client over `transport`, closing it on failure. */
  const connectWith = async (transport: Transport): Promise<Client> => {
    const client = newClient();
    try {
      await client.connect(transport);
      return client;
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      throw error;
    }
  };

  const connectStdio = (
    server: StdioServerConfig,
    revealed: Record<string, string>,
  ): Promise<Client> => {
    // Decrypted values go straight into the spawn call.
    const resolved = resolveStdioTemplates(server, revealed);

    return connectWith(
      new StdioClientTransport({
        command: server.command,
        args: resolved.args,
        env: { ...getDefaultEnvironment(), ...resolved.env },
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      }),
    );
  };

  const connectRemote = async (
    name: string,
    server: RemoteServerConfig,
    revealed: Record<string, string>,
    secretValues: readonly string[],
  ): Promise<Client> => {
    const resolved = resolveRemoteTemplates(server, revealed);
    const url = new URL(resolved.url);
    const options = {
      requestInit: { headers: resolved.headers },
      ...(server.insecureTls ? { fetch: insecureFetch() } : {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const sse = (): Transport => new SSEClientTransport(url, options);
    // StreamableHTTPClientTransport declares `sessionId: string | undefined`
    // where Transport says `sessionId?: string`; under
    // exactOptionalPropertyTypes that is not assignable, so cast at the SDK
    // boundary.
    const streamable = (): Transport =>
      new StreamableHTTPClientTransport(url, options) as unknown as Transport;

    if (server.type === 'sse') {
      return connectWith(sse());
    }

    // `http`/`https`: modern transport first, SSE as a compatibility fallback
    // (the MCP-recommended client behaviour during the migration period).
    let primaryFailure: string;
    try {
      return await connectWith(streamable());
    } catch (error: unknown) {
      primaryFailure = redactSecrets(errorMessage(error), secretValues);
      trace(`streamable http failed for '${name}' (${primaryFailure}); falling back to SSE`);
    }

    try {
      return await connectWith(sse());
    } catch (error: unknown) {
      // Surface both attempts: the streamable error usually carries the real
      // root cause (bad token, TLS, DNS), the SSE one just echoes it worse.
      throw new Error(
        `Streamable HTTP: ${primaryFailure}; SSE fallback: ${redactSecrets(errorMessage(error), secretValues)}`,
      );
    }
  };

  const spawn = async (name: string): Promise<StartResult> => {
    const server = config.servers[name];
    if (server === undefined) {
      throw new Error(`Unknown server '${name}'`);
    }

    const entry = runtime(name);
    // Decrypt once, at the last possible moment; the values double as the
    // redaction list for every error path below.
    const revealed = vault.reveal(secretNamesFor(name));
    const secretValues = Object.values(revealed);

    try {
      const client =
        server.type === 'stdio'
          ? await connectStdio(server, revealed)
          : await connectRemote(name, server, revealed, secretValues);

      try {
        const { tools } = await client.listTools();
        entry.state = 'running';
        entry.client = client;
        entry.tools = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      } catch (error: unknown) {
        await client.close().catch(() => undefined);
        throw error;
      }

      // A child that dies on its own (crashed process, dropped connection)
      // must not stay 'running': mark it, drop its tools, and let a later
      // secure_env_start reconnect it. A deliberate stop() clears
      // entry.client first, so the guard keeps this from firing then.
      client.onclose = () => {
        if (entry.client !== client) {
          return;
        }

        delete entry.client;
        delete entry.tools;
        entry.state = 'error';
        entry.lastError = 'Connection closed unexpectedly; start the server again to reconnect.';
        trace(`server '${name}' connection closed unexpectedly`);
        notifyToolsChanged();
      };

      delete entry.signInUrl;
      delete entry.lastError;
      trace(`server '${name}' started with ${String(entry.tools.length)} tool(s)`);
      notifyToolsChanged();
      return {
        ok: true,
        serverName: name,
        tools: entry.tools.map((tool) => `${name}${TOOL_SEPARATOR}${tool.name}`),
        alreadyRunning: false,
      };
    } catch (error: unknown) {
      const message = redactSecrets(errorMessage(error), secretValues);
      entry.state = 'error';
      entry.lastError = message;
      delete entry.client;
      delete entry.tools;
      trace(`server '${name}' failed to start: ${message}`);
      throw new Error(`Server '${name}' failed to start: ${message}`);
    }
  };

  const startOnce = async (name: string): Promise<StartResult> => {
    const entry = runtime(name);
    const fields = secretFieldsFor(name);
    const resolution: SecretResolution = await secretRequests.requestSecrets(name, fields);

    if (!resolution.ok) {
      entry.state = 'stopped';
      entry.signInUrl = resolution.url;
      return resolution;
    }

    delete entry.signInUrl;
    return spawn(name);
  };

  // Async so that validation failures reject instead of throwing synchronously.
  const ensureStarted = async (name: string): Promise<StartResult> => {
    const entry = runtime(name);

    if (entry.state === 'running' && entry.client !== undefined) {
      return {
        ok: true,
        serverName: name,
        tools: (entry.tools ?? []).map((tool) => `${name}${TOOL_SEPARATOR}${tool.name}`),
        alreadyRunning: true,
      };
    }

    if (entry.startPromise !== undefined) {
      return entry.startPromise;
    }

    entry.state = 'starting';
    const start = startOnce(name).finally(() => {
      delete entry.startPromise;
      if (runtime(name).state === 'starting') {
        runtime(name).state = 'stopped';
      }
    });
    entry.startPromise = start;
    return start;
  };

  const stop = async (name: string): Promise<boolean> => {
    const entry = runtime(name);

    // A start may be mid-connect (client not yet assigned): wait for it to
    // settle so its child cannot outlive the stop.
    if (entry.startPromise !== undefined) {
      await entry.startPromise.catch(() => undefined);
    }

    if (entry.client === undefined) {
      return false;
    }

    const client = entry.client;
    delete entry.client;
    delete entry.tools;
    entry.state = 'stopped';
    await client.close().catch((error: unknown) => {
      trace(`closing '${name}': ${errorMessage(error)}`);
    });
    trace(`server '${name}' stopped`);
    notifyToolsChanged();
    return true;
  };

  const stopAll = async (): Promise<void> => {
    await Promise.all([...runtimes.keys()].map((name) => stop(name)));
    if (insecureDispatcher !== undefined) {
      await insecureDispatcher.close().catch(() => undefined);
      insecureDispatcher = undefined;
    }
  };

  const status = (): ChildStatus[] =>
    [...runtimes.entries()].map(([name, entry]) => {
      const server = config.servers[name];
      const missing = vault.missing(secretFieldsFor(name).map((field) => field.name));
      const base: ChildStatus = {
        name,
        state: entry.state,
        transport: server?.type ?? 'stdio',
        autoStart: server?.autoStart ?? false,
        missingSecrets: missing,
      };
      return {
        ...base,
        ...(entry.signInUrl === undefined ? {} : { signInUrl: entry.signInUrl }),
        ...(entry.tools === undefined ? {} : { toolCount: entry.tools.length }),
        ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
      };
    });

  const listTools = (): ChildToolInfo[] => {
    const tools: ChildToolInfo[] = [];
    for (const [name, entry] of runtimes.entries()) {
      if (entry.state !== 'running' || entry.tools === undefined) {
        continue;
      }

      for (const tool of entry.tools) {
        tools.push({
          serverName: name,
          name: `${name}${TOOL_SEPARATOR}${tool.name}`,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        });
      }
    }

    return tools;
  };

  const callTool = async (
    namespacedName: string,
    args: Record<string, unknown> | undefined,
  ): Promise<unknown> => {
    const separatorIndex = namespacedName.indexOf(TOOL_SEPARATOR);
    if (separatorIndex <= 0) {
      throw new Error(`Unknown tool '${namespacedName}'`);
    }

    const serverName = namespacedName.slice(0, separatorIndex);
    const toolName = namespacedName.slice(separatorIndex + TOOL_SEPARATOR.length);
    const entry = runtime(serverName);

    if (entry.state !== 'running' || entry.client === undefined) {
      throw new Error(
        `Server '${serverName}' is not running. Call secure_env_start with {"server": "${serverName}"} first.`,
      );
    }

    try {
      return await entry.client.callTool({ name: toolName, arguments: args ?? {} });
    } catch (error: unknown) {
      // Mid-session transport errors can echo the request URL or upstream
      // response bodies; scrub the server's secret values before the message
      // reaches the MCP client.
      throw new Error(redactSecrets(errorMessage(error), secretValuesFor(serverName)));
    }
  };

  return {
    names: () => [...runtimes.keys()],
    status,
    ensureStarted,
    stop,
    stopAll,
    listTools,
    callTool,
  };
}
