import {
  type ChildServerConfig,
  type InputType,
  type RemoteServerConfig,
  type StdioServerConfig,
} from '../schemas/wrapper-config.js';

// `${secure:NAME}` or `${secure:NAME:type}` — NAME follows env-var naming and
// the optional type picks the HTML input widget on the sign-in form.
const PLACEHOLDER =
  /\$\{secure:([A-Za-z_][A-Za-z0-9_]*)(?::(text|password|email|number|url|tel))?\}/g;

/** One `${secure:…}` reference found in a server's config. */
export interface SecretReference {
  name: string;
  /** Explicit input type from the placeholder, when given. */
  input?: InputType;
}

function* scan(value: string): Generator<SecretReference> {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const [, name, input] = match as unknown as [string, string, InputType | undefined];
    yield input === undefined ? { name } : { name, input };
  }
}

/** Every string in a server's config that may carry placeholders. */
function templateStrings(server: ChildServerConfig): string[] {
  if (server.type === 'stdio') {
    return [...Object.values(server.env), ...server.args];
  }

  return [server.url, ...Object.values(server.headers)];
}

/**
 * Collect every secret referenced by a server's config — `env` values and
 * `args` for stdio servers, `url` and `headers` for remote ones —
 * deduplicated by name. When the same secret appears more than once, the
 * first occurrence carrying an explicit input type wins.
 */
export function collectSecretReferences(server: ChildServerConfig): SecretReference[] {
  const byName = new Map<string, SecretReference>();

  for (const value of templateStrings(server)) {
    for (const reference of scan(value)) {
      const existing = byName.get(reference.name);
      if (existing === undefined) {
        byName.set(reference.name, reference);
      } else if (existing.input === undefined && reference.input !== undefined) {
        byName.set(reference.name, reference);
      }
    }
  }

  return [...byName.values()];
}

/** Replace every `${secure:…}` in `value` with its secret. Throws on a miss. */
export function resolvePlaceholders(value: string, secrets: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (_match, name: string) => {
    const secret = secrets[name];
    if (secret === undefined) {
      throw new Error(`No value available for secret '${name}'`);
    }

    return secret;
  });
}

/** The fully resolved spawn parameters for a stdio child server. */
export interface ResolvedStdioTemplates {
  args: string[];
  env: Record<string, string>;
}

export function resolveStdioTemplates(
  server: StdioServerConfig,
  secrets: Record<string, string>,
): ResolvedStdioTemplates {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    env[key] = resolvePlaceholders(value, secrets);
  }

  return {
    args: server.args.map((argument) => resolvePlaceholders(argument, secrets)),
    env,
  };
}

/** The fully resolved connection parameters for a remote child server. */
export interface ResolvedRemoteTemplates {
  url: string;
  headers: Record<string, string>;
}

export function resolveRemoteTemplates(
  server: RemoteServerConfig,
  secrets: Record<string, string>,
): ResolvedRemoteTemplates {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.headers)) {
    headers[key] = resolvePlaceholders(value, secrets);
  }

  return { url: resolvePlaceholders(server.url, secrets), headers };
}
