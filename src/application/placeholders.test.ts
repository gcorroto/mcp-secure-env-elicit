import { describe, expect, it } from 'vitest';

import {
  type RemoteServerConfig,
  type StdioServerConfig,
} from '../schemas/wrapper-config.js';
import {
  collectSecretReferences,
  resolvePlaceholders,
  resolveRemoteTemplates,
  resolveStdioTemplates,
} from './placeholders.js';

function stdioServer(partial: Partial<StdioServerConfig>): StdioServerConfig {
  return { type: 'stdio', command: 'node', args: [], env: {}, autoStart: false, ...partial };
}

function remoteServer(partial: Partial<RemoteServerConfig>): RemoteServerConfig {
  return {
    type: 'http',
    url: 'https://example.com/mcp',
    headers: {},
    insecureTls: false,
    autoStart: false,
    ...partial,
  };
}

describe('collectSecretReferences', () => {
  it('finds references in env values and args, deduplicated', () => {
    const references = collectSecretReferences(
      stdioServer({
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

  it('finds references in a remote server url and headers', () => {
    const references = collectSecretReferences(
      remoteServer({
        url: 'https://sonar.example.com/mcp?key=${secure:URL_KEY}',
        headers: {
          SONARQUBE_TOKEN: '${secure:SONARQUBE_TOKEN}',
          'X-Api-Key': '${secure:API_KEY:password}',
        },
      }),
    );

    expect(references).toEqual([
      { name: 'URL_KEY' },
      { name: 'SONARQUBE_TOKEN' },
      { name: 'API_KEY', input: 'password' },
    ]);
  });

  it('keeps the explicit input type when the same secret repeats', () => {
    const references = collectSecretReferences(
      stdioServer({
        env: { A: '${secure:TOKEN}', B: '${secure:TOKEN:password}', C: '${secure:TOKEN}' },
      }),
    );

    expect(references).toEqual([{ name: 'TOKEN', input: 'password' }]);
  });

  it('returns nothing for a server without placeholders', () => {
    expect(collectSecretReferences(stdioServer({ env: { PLAIN: 'value' } }))).toEqual([]);
    expect(collectSecretReferences(remoteServer({ headers: { Accept: 'text/plain' } }))).toEqual(
      [],
    );
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

describe('resolveStdioTemplates', () => {
  it('resolves env and args together', () => {
    const resolved = resolveStdioTemplates(
      stdioServer({
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

describe('resolveRemoteTemplates', () => {
  it('resolves url and headers together', () => {
    const resolved = resolveRemoteTemplates(
      remoteServer({
        url: 'https://api.example.com/mcp?key=${secure:URL_KEY}',
        headers: { Authorization: 'Bearer ${secure:TOKEN}', Accept: 'application/json' },
      }),
      { URL_KEY: 'k1', TOKEN: 't1' },
    );

    expect(resolved).toEqual({
      url: 'https://api.example.com/mcp?key=k1',
      headers: { Authorization: 'Bearer t1', Accept: 'application/json' },
    });
  });
});
