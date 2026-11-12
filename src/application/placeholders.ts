import { homedir, tmpdir } from 'node:os';
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
  cwd?: string;
}

export function resolveStdioTemplates(
  server: StdioServerConfig,
  secrets: Record<string, string>,
  paths: Record<string, string> = {},
): ResolvedStdioTemplates {
  const resolve = (value: string): string =>
    resolvePlaceholders(expandPaths(value, paths), secrets);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    env[key] = resolve(value);
  }

  return {
    args: server.args.map(resolve),
    env,
    ...(server.cwd === undefined ? {} : { cwd: resolve(server.cwd) }),
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

/** Expand only path expressions, leaving unrelated text and secret placeholders intact. */
export function expandPaths(
  value: string,
  paths: Record<string, string> = {},
  options: {
    home?: string;
    temp?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? '\\' : '/';
  const normalize = (part: string): string => part.replace(/[\\/]/g, separator);
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  let expanded = value.replace(/^~(?=[\\/])/, normalize(home));
  expanded = expanded.replace(
    /\$\{(home|tmpdir|env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?|path:([A-Za-z_][A-Za-z0-9_]*))\}/g,
    (
      _match,
      expression: string,
      name: string | undefined,
      fallback: string | undefined,
      pathName: string | undefined,
    ) => {
      let result: string | undefined;
      if (expression === 'home') result = home;
      else if (expression === 'tmpdir') result = options.temp ?? tmpdir();
      else if (pathName !== undefined) {
        result = paths[pathName];
        if (result === undefined) throw new Error(`No path setting named '${pathName}'`);
      } else if (name !== undefined) {
        result = env[name];
        if ((result === undefined || result === '') && fallback !== undefined) result = fallback;
        if (result === undefined) throw new Error(`Environment variable '${name}' is not set`);
      }
      return normalize(result ?? '');
    },
  );
  // Normalize separators adjacent to expanded paths without rewriting arbitrary arguments.
  if (/^(?:~[\\/]|\$\{(?:home|tmpdir|env:|path:))/.test(value)) return normalize(expanded);
  return expanded;
}
