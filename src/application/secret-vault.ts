import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * In-memory encrypted store for secret values.
 *
 * Values are sealed with AES-256-GCM under a key minted at process start and
 * held only in this closure, so plain secrets never sit long-lived on the
 * heap and never touch disk. `reveal` decrypts on demand — done only at child
 * spawn time, immediately before the values go into the child's environment.
 */
export interface SecretVault {
  set: (name: string, value: string) => void;
  has: (name: string) => boolean;
  /** The subset of `names` that has no stored value yet. */
  missing: (names: readonly string[]) => string[];
  /** Decrypt the requested secrets. Throws if any of them is missing. */
  reveal: (names: readonly string[]) => Record<string, string>;
  /** Drop every secret and the encryption key (shutdown). */
  dispose: () => void;
}

interface SealedEntry {
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

export function createSecretVault(): SecretVault {
  let key: Buffer | undefined = randomBytes(32);
  const entries = new Map<string, SealedEntry>();

  const requireKey = (): Buffer => {
    if (key === undefined) {
      throw new Error('Secret vault has been disposed');
    }

    return key;
  };

  const set = (name: string, value: string): void => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', requireKey(), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    entries.set(name, { iv, tag: cipher.getAuthTag(), data });
  };

  const has = (name: string): boolean => entries.has(name);

  const missing = (names: readonly string[]): string[] =>
    [...new Set(names)].filter((name) => !entries.has(name));

  const reveal = (names: readonly string[]): Record<string, string> => {
    const values: Record<string, string> = {};

    for (const name of new Set(names)) {
      const entry = entries.get(name);
      if (entry === undefined) {
        throw new Error(`Secret '${name}' is not in the vault`);
      }

      const decipher = createDecipheriv('aes-256-gcm', requireKey(), entry.iv);
      decipher.setAuthTag(entry.tag);
      values[name] = Buffer.concat([decipher.update(entry.data), decipher.final()]).toString(
        'utf8',
      );
    }

    return values;
  };

  const dispose = (): void => {
    entries.clear();
    key?.fill(0);
    key = undefined;
  };

  return { set, has, missing, reveal, dispose };
}
