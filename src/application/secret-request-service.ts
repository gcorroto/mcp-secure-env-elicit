import { randomUUID } from 'node:crypto';

import { type InputType } from '../schemas/wrapper-config.js';
import { type SecretVault } from './secret-vault.js';

/** One field the operator has to fill in on the sign-in form. */
export interface SecretField {
  name: string;
  input: InputType;
  description?: string;
}

/** Details of a live sign-in request, used to render the form. */
export interface PendingSecretPrompt {
  serverName: string;
  fields: readonly SecretField[];
}

/**
 * Outcome of a secret request. On `ok` every requested secret is in the
 * vault; otherwise the operator must open `url` and submit the values before
 * retrying.
 */
export type SecretResolution =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: 'SECRETS_REQUIRED'; url: string; message: string }>;

/** Consumed by the HTTP `/auth` routes to gate and complete the form. */
export interface AuthPagePort {
  /** Details for a live, unredeemed token; `undefined` otherwise. */
  describe: (token: string) => PendingSecretPrompt | undefined;
  /**
   * Complete a request by storing the submitted values in the vault. Returns
   * `false` for an unknown/used token or when a required field is missing.
   */
  submit: (token: string, values: Record<string, string>) => boolean;
}

/** The minimal surface of the connected MCP client used to raise the form. */
export interface McpClientBridge {
  /** Whether the client advertised URL-mode elicitation support. */
  supportsUrlElicitation: () => boolean;
  /**
   * Send a URL-mode elicitation and resolve with the user's action. The
   * optional `signal` cancels the prompt (e.g. once the values arrived
   * out-of-band via `POST /auth`), dismissing the client's dialog.
   */
  elicitUrl: (
    params: { message: string; url: string },
    options?: { signal?: AbortSignal },
  ) => Promise<{ action: 'accept' | 'decline' | 'cancel' }>;
}

export interface SecretRequestService extends AuthPagePort {
  /**
   * Ensure every field's secret is in the vault, prompting the operator once
   * for the missing ones. Concurrent requests for the same server share a
   * single prompt; distinct servers prompt one at a time.
   */
  requestSecrets: (serverName: string, fields: readonly SecretField[]) => Promise<SecretResolution>;
  /** Abandon any in-flight sign-in (shutdown). */
  dispose: () => void;
}

export type SecretRequestServiceDeps = Readonly<{
  /**
   * Base URL of the loopback server, e.g. `https://127.0.0.1:3000`. May be a
   * function so the actual (possibly ephemeral) bound port can be supplied
   * after the server starts listening.
   */
  authBaseUrl: string | (() => string);
  client: McpClientBridge;
  vault: SecretVault;
  /** Path of the sign-in route. Defaults to `/auth`. */
  authPath?: string;
  /** Mint an unguessable single-use token. Defaults to `randomUUID`. */
  createToken?: () => string;
  /** How long a token stays redeemable, in ms. Defaults to 5 min. */
  requestTimeoutMs?: number;
}>;

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

function trace(message: string): void {
  // Diagnostics only ever go to stderr, and never include a secret value.
  process.stderr.write(`[secure-env] ${message}\n`);
}

interface PendingSignIn {
  serverName: string;
  fields: readonly SecretField[];
  resolve: () => void;
}

/**
 * Create the interactive secret-collection service.
 *
 * Secrets are never read from this process's environment or a file. When a
 * child server needs values that are not in the vault, the service prompts
 * (via URL-mode elicitation pointing at the loopback sign-in page) and the
 * submitted values land in the encrypted vault. When the client cannot render
 * elicitation, the resolver returns `SECRETS_REQUIRED` carrying the URL for
 * the caller to surface as text; the token behind that URL stays redeemable
 * for the whole sign-in window, so the operator can submit the values and
 * simply re-run the command.
 */
export function createSecretRequestService(deps: SecretRequestServiceDeps): SecretRequestService {
  const authPath = deps.authPath ?? '/auth';
  const createToken = deps.createToken ?? ((): string => randomUUID());
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const vault = deps.vault;

  const pending = new Map<string, PendingSignIn>();
  const pendingByServer = new Map<string, Promise<SecretResolution>>();
  // Serializes prompts so at most one sign-in dialog is shown at a time.
  let promptChain: Promise<unknown> = Promise.resolve();

  const baseUrl = (): string =>
    typeof deps.authBaseUrl === 'function' ? deps.authBaseUrl() : deps.authBaseUrl;

  const signInUrl = (token: string): string =>
    `${baseUrl()}${authPath}?token=${encodeURIComponent(token)}`;

  const acquire = async (
    serverName: string,
    fields: readonly SecretField[],
  ): Promise<SecretResolution> => {
    const token = createToken();
    const url = signInUrl(token);
    const names = fields.map((field) => field.name).join(', ');

    let resolvePending!: () => void;
    const valuesArrived = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    pending.set(token, { serverName, fields, resolve: resolvePending });

    // The timer owns the token's lifetime: an unredeemed token stays valid
    // for the whole sign-in window — even after this call has returned the
    // URL as text to a client without elicitation — and is swept when it
    // closes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        pending.delete(token);
        resolve('timeout');
      }, requestTimeoutMs);
      timer.unref();
    });

    const elicitAbort = new AbortController();
    const notCompleted: SecretResolution = {
      ok: false,
      code: 'SECRETS_REQUIRED',
      url,
      message:
        `Server '${serverName}' needs values for: ${names}. ` +
        `Open ${url} to provide them, then run the command again.`,
    };

    try {
      if (!deps.client.supportsUrlElicitation()) {
        trace(`client lacks url elicitation; returning sign-in URL for '${serverName}'`);
        return notCompleted;
      }

      trace(`requesting values for '${serverName}' (${names}) via url elicitation`);
      const elicited = deps.client
        .elicitUrl(
          {
            message: `Provide the environment values for MCP server '${serverName}': ${names}.`,
            url,
          },
          { signal: elicitAbort.signal },
        )
        .then((result) => ({ kind: 'elicit' as const, action: result.action }))
        .catch((error: unknown) => {
          trace(`elicitation ended: ${error instanceof Error ? error.message : String(error)}`);
          return { kind: 'elicit' as const, action: 'cancel' as const };
        });

      const first = await Promise.race([
        valuesArrived.then(() => ({ kind: 'values' as const })),
        elicited,
        timedOut.then(() => ({ kind: 'timeout' as const })),
      ]);

      if (first.kind === 'values') {
        // Values arrived via POST /auth; dismiss the client's dialog.
        elicitAbort.abort();
        trace(`values received for '${serverName}'`);
        return { ok: true };
      }

      // The client reported the flow finished; give the browser POST a brief
      // moment to land before giving up (submit and CLI-confirm can race).
      if (first.kind === 'elicit' && first.action === 'accept') {
        const late = await Promise.race([
          valuesArrived.then(() => ({ kind: 'values' as const })),
          timedOut.then(() => ({ kind: 'timeout' as const })),
        ]);
        if (late.kind === 'values') {
          trace(`values received for '${serverName}' after confirm`);
          return { ok: true };
        }
      }

      trace(`sign-in not completed for '${serverName}' (${first.kind})`);
      return notCompleted;
    } finally {
      // Stop the sweep only once the token has been redeemed; otherwise leave
      // token and timer alive so the operator can still sign in and retry.
      if (timer !== undefined && !pending.has(token)) {
        clearTimeout(timer);
      }
    }
  };

  const promptFor = async (
    serverName: string,
    fields: readonly SecretField[],
  ): Promise<SecretResolution> => {
    // Re-check after waiting in the serialized queue: a submit that ran ahead
    // of us may have filled the vault already.
    const stillMissing = fields.filter((field) => !vault.has(field.name));
    if (stillMissing.length === 0) {
      return { ok: true };
    }

    return acquire(serverName, stillMissing);
  };

  const enqueue = (fn: () => Promise<SecretResolution>): Promise<SecretResolution> => {
    const run = promptChain.then(fn, fn);
    promptChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const requestSecrets = (
    serverName: string,
    fields: readonly SecretField[],
  ): Promise<SecretResolution> => {
    const missing = fields.filter((field) => !vault.has(field.name));
    if (missing.length === 0) {
      return Promise.resolve({ ok: true });
    }

    const existing = pendingByServer.get(serverName);
    if (existing !== undefined) {
      return existing;
    }

    const prompt = enqueue(() => promptFor(serverName, missing)).finally(() => {
      pendingByServer.delete(serverName);
    });
    pendingByServer.set(serverName, prompt);
    return prompt;
  };

  const describe = (token: string): PendingSecretPrompt | undefined => {
    const entry = pending.get(token);
    if (entry === undefined) {
      return undefined;
    }

    return { serverName: entry.serverName, fields: entry.fields };
  };

  const submit = (token: string, values: Record<string, string>): boolean => {
    const entry = pending.get(token);
    if (entry === undefined) {
      return false;
    }

    // All fields must arrive together; a partial submit leaves the token
    // valid so the operator can fix the form and retry.
    const validated: [string, string][] = [];
    for (const field of entry.fields) {
      const value = values[field.name];
      if (value === undefined || value === '') {
        return false;
      }
      validated.push([field.name, value]);
    }

    pending.delete(token);
    // Persist here rather than around acquire(): when the sign-in URL was
    // surfaced as text, the call that minted this token has long returned and
    // only a retry can pick the values up — from the vault.
    for (const [name, value] of validated) {
      vault.set(name, value);
    }

    entry.resolve();
    return true;
  };

  const dispose = (): void => {
    pending.clear();
    pendingByServer.clear();
  };

  return { requestSecrets, describe, submit, dispose };
}
