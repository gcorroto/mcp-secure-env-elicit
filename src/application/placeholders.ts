import { type ChildServerConfig, type InputType } from '../schemas/wrapper-config.js';

// `${secure:NAME}` or `${secure:NAME:type}` — NAME follows env-var naming and
// the optional type picks the HTML input widget on the sign-in form.
const PLACEHOLDER = /\$\{secure:([A-Za-z_][A-Za-z0-9_]*)(?::(text|password|email|number|url|tel))?\}/g;

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

/**
 * Collect every secret referenced by a server's `env` values and `args`,
 * deduplicated by name. When the same secret appears more than once, the
 * first occurrence carrying an explicit input type wins.
 */
export function collectSecretReferences(server: ChildServerConfig): SecretReference[] {
  const byName = new Map<string, SecretReference>();

  const take = (reference: SecretReference): void => {
    const existing = byName.get(reference.name);
    if (existing === undefined) {
      byName.set(reference.name, reference);
      return;
    }

    if (existing.input === undefined && reference.input !== undefined) {
      byName.set(reference.name, reference);
    }
  };

  for (const value of Object.values(server.env)) {
    for (const reference of scan(value)) {
      take(reference);
    }
  }

  for (const argument of server.args) {
    for (const reference of scan(argument)) {
      take(reference);
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

/** The fully resolved spawn parameters for a child server. */
export interface ResolvedTemplates {
  args: string[];
  env: Record<string, string>;
}

export function resolveServerTemplates(
  server: ChildServerConfig,
  secrets: Record<string, string>,
): ResolvedTemplates {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    env[key] = resolvePlaceholders(value, secrets);
  }

  return {
    args: server.args.map((argument) => resolvePlaceholders(argument, secrets)),
    env,
  };
}
