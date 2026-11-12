import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { type WrapperConfig } from '../schemas/wrapper-config.js';
import { expandPaths } from './placeholders.js';

export interface PathSettings {
  values: () => Record<string, string>;
  display: () => Record<string, string>;
  save: (input: Record<string, string>) => void;
  prepare: (templates: string[]) => Record<string, string>;
}
export function createPathSettings(
  config: WrapperConfig,
  source: string,
  stateDir: string,
): PathSettings {
  const file = join(stateDir, `${createHash('sha256').update(source).digest('hex')}.json`);
  const read = (): Record<string, string> => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.values(value).some((entry) => typeof entry !== 'string')
      )
        throw new Error('Invalid settings');
      return value as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`Cannot read local path settings: ${String(error)}`);
    }
  };
  const validate = (name: string, value: string): string => {
    const expanded = expandPaths(value);
    if (!isAbsolute(expanded) || expanded.includes('\0')) {
      throw new Error(`Path '${name}' must be an absolute path after expansion`);
    }
    return expanded;
  };
  const values = (): Record<string, string> => {
    const overrides = read();
    return Object.fromEntries(
      Object.entries(config.paths).map(([name, meta]) => [
        name,
        validate(name, overrides[name] ?? meta.default),
      ]),
    );
  };
  return {
    values,
    display: (): Record<string, string> => {
      const overrides = read();
      return Object.fromEntries(
        Object.entries(config.paths).map(([name, meta]) => {
          const value = overrides[name] ?? meta.default;
          try {
            return [name, expandPaths(value)];
          } catch {
            return [name, value];
          }
        }),
      );
    },
    save: (input: Record<string, string>): void => {
      const validated = Object.fromEntries(
        Object.keys(config.paths).map((name) => [name, validate(name, input[name] ?? '')]),
      );
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
    },
    prepare: (templates: string[]): Record<string, string> => {
      const referenced = new Set(
        templates.flatMap((template) =>
          [...template.matchAll(/\$\{path:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
            (match) => match[1] ?? '',
          ),
        ),
      );
      const overrides = read();
      const resolved: Record<string, string> = {};
      for (const name of referenced) {
        const meta = config.paths[name];
        if (meta === undefined) throw new Error(`No path setting named '${name}'`);
        const value = validate(name, overrides[name] ?? meta.default);
        resolved[name] = value;
        if (meta.createParent) mkdirSync(dirname(value), { recursive: true });
      }
      return resolved;
    },
  };
}
