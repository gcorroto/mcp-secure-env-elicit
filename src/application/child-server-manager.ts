import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { type WrapperConfig } from '../schemas/wrapper-config.js';
import { resolveInputType } from './input-type.js';
import { collectSecretReferences, resolveServerTemplates } from './placeholders.js';
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

export function createChildServerManager(deps: ChildServerManagerDeps): ChildServerManager {
  const { config, vault, secretRequests } = deps;
  const runtimes = new Map<string, ChildRuntime>();
  for (const name of Object.keys(config.servers)) {
    runtimes.set(name, { state: 'stopped' });
  }

  const runtime = (name: string): ChildRuntime => {
    const entry = runtimes.get(name);
    if (entry === undefined) {
      throw new Error(
        `Unknown server '${name}'. Configured servers: ${Object.keys(config.servers).join(', ')}`,
      );
    }

    return entry;
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

  const spawn = async (name: string): Promise<StartResult> => {
    const server = config.servers[name];
    if (server === undefined) {
      throw new Error(`Unknown server '${name}'`);
    }

    const entry = runtime(name);
    const secretNames = collectSecretReferences(server).map((reference) => reference.name);
    // Decrypt at the last possible moment, straight into the spawn call.
    const resolved = resolveServerTemplates(server, vault.reveal(secretNames));

    const client = new Client(
      { name: 'mcp-secure-env-elicit', version: deps.clientVersion ?? '0.0.0' },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: server.command,
      args: resolved.args,
      env: { ...getDefaultEnvironment(), ...resolved.env },
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      entry.state = 'running';
      entry.client = client;
      entry.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      delete entry.signInUrl;
      delete entry.lastError;
      trace(`server '${name}' started with ${String(tools.length)} tool(s)`);
      notifyToolsChanged();
      return {
        ok: true,
        serverName: name,
        tools: entry.tools.map((tool) => `${name}${TOOL_SEPARATOR}${tool.name}`),
        alreadyRunning: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      entry.state = 'error';
      entry.lastError = message;
      delete entry.client;
      delete entry.tools;
      await client.close().catch(() => undefined);
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
    if (entry.client === undefined) {
      return false;
    }

    const client = entry.client;
    delete entry.client;
    delete entry.tools;
    entry.state = 'stopped';
    await client.close().catch((error: unknown) => {
      trace(`closing '${name}': ${error instanceof Error ? error.message : String(error)}`);
    });
    trace(`server '${name}' stopped`);
    notifyToolsChanged();
    return true;
  };

  const stopAll = async (): Promise<void> => {
    await Promise.all([...runtimes.keys()].map((name) => stop(name)));
  };

  const status = (): ChildStatus[] =>
    [...runtimes.entries()].map(([name, entry]) => {
      const server = config.servers[name];
      const missing = vault.missing(secretFieldsFor(name).map((field) => field.name));
      const base: ChildStatus = {
        name,
        state: entry.state,
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

    return entry.client.callTool({ name: toolName, arguments: args ?? {} });
  };

  return { names: () => [...runtimes.keys()], status, ensureStarted, stop, stopAll, listTools, callTool };
}
