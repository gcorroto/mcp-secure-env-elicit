import { describe, expect, it } from 'vitest';

import { type ChildServerConfig } from '../schemas/wrapper-config.js';
import {
  collectSecretReferences,
  resolvePlaceholders,
  resolveServerTemplates,
} from './placeholders.js';

function server(partial: Partial<ChildServerConfig>): ChildServerConfig {
  return { command: 'node', args: [], env: {}, autoStart: false, ...partial };
}

describe('collectSecretReferences', () => {
  it('finds references in env values and args, deduplicated', () => {
    const references = collectSecretReferences(
      server({
        args: ['--dsn', 'oracle://scott:${secure:ORACLE_PASSWORD}@db:1521/XE'],
        env: {
          ORACLE_USER: 'scott',
          ORACLE_PASSWORD: '${secure:ORACLE_PASSWORD}',
          SMTP: '${secure:SMTP_USER:email}:${secure:SMTP_PASSWORD}',
        },
      }),
    );

    expect(references).toEqual([
      { name: 'ORACLE_PASSWORD' },
      { name: 'SMTP_USER', input: 'email' },
      { name: 'SMTP_PASSWORD' },
    ]);
  });

  it('keeps the explicit input type when the same secret repeats', () => {
    const references = collectSecretReferences(
      server({
        env: { A: '${secure:TOKEN}', B: '${secure:TOKEN:password}', C: '${secure:TOKEN}' },
      }),
    );

    expect(references).toEqual([{ name: 'TOKEN', input: 'password' }]);
  });

  it('returns nothing for a server without placeholders', () => {
    expect(collectSecretReferences(server({ env: { PLAIN: 'value' } }))).toEqual([]);
  });
});

describe('resolvePlaceholders', () => {
  it('substitutes placeholders embedded in larger strings', () => {
    expect(
      resolvePlaceholders('postgres://u:${secure:PW}@h/${secure:DB:text}', {
        PW: 's3cret',
        DB: 'app',
      }),
    ).toBe('postgres://u:s3cret@h/app');
  });

  it('leaves strings without placeholders untouched', () => {
    expect(resolvePlaceholders('plain ${other:X} $secure', {})).toBe('plain ${other:X} $secure');
  });

  it('throws when a secret is missing', () => {
    expect(() => resolvePlaceholders('${secure:GONE}', {})).toThrow(
      "No value available for secret 'GONE'",
    );
  });
});

describe('resolveServerTemplates', () => {
  it('resolves env and args together', () => {
    const resolved = resolveServerTemplates(
      server({
        args: ['--token', '${secure:TOKEN}'],
        env: { TOKEN: '${secure:TOKEN}', HOST: 'db' },
      }),
      { TOKEN: 'abc' },
    );

    expect(resolved).toEqual({
      args: ['--token', 'abc'],
      env: { TOKEN: 'abc', HOST: 'db' },
    });
  });
});
