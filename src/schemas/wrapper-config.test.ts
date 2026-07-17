import { describe, expect, it } from 'vitest';

import { WrapperConfigSchema } from './wrapper-config.js';

describe('WrapperConfigSchema', () => {
  it('defaults entries without a type to stdio (backwards compatible)', () => {
    const config = WrapperConfigSchema.parse({
      servers: {
        oracle: { command: 'npx', args: ['-y', '@grec0/mcp-oracle-db'] },
      },
    });

    expect(config.servers.oracle).toMatchObject({ type: 'stdio', command: 'npx' });
  });

  it('accepts remote servers with url, headers, and insecureTls', () => {
    const config = WrapperConfigSchema.parse({
      servers: {
        sonarqube: {
          type: 'https',
          url: 'https://sonar.example.com/mcp',
          headers: { SONARQUBE_TOKEN: '${secure:SONARQUBE_TOKEN}' },
          insecureTls: true,
        },
        db: {
          type: 'sse',
          url: 'https://db.example.com/sse',
          headers: { 'X-Api-Key': '${secure:API_KEY}' },
        },
      },
    });

    expect(config.servers.sonarqube).toMatchObject({ type: 'https', insecureTls: true });
    expect(config.servers.db).toMatchObject({ type: 'sse', insecureTls: false, headers: { 'X-Api-Key': '${secure:API_KEY}' } });
  });

  it('rejects a remote server without a valid url', () => {
    expect(() =>
      WrapperConfigSchema.parse({
        servers: { bad: { type: 'http', url: 'not-a-url' } },
      }),
    ).toThrow();
  });

  it('accepts placeholders anywhere in the url, including host and port', () => {
    const config = WrapperConfigSchema.parse({
      servers: {
        hidden: { type: 'http', url: 'https://${secure:HOST}:${secure:PORT}/mcp' },
        query: { type: 'sse', url: 'https://example.com/sse?key=${secure:KEY}' },
      },
    });

    expect(config.servers.hidden).toMatchObject({
      url: 'https://${secure:HOST}:${secure:PORT}/mcp',
    });
  });

  it('rejects non-http(s) url schemes at config load', () => {
    expect(() =>
      WrapperConfigSchema.parse({
        servers: { bad: { type: 'http', url: 'ftp://example.com/mcp' } },
      }),
    ).toThrow(/http\(s\)/);
  });

  it('rejects a stdio server that carries remote fields', () => {
    expect(() =>
      WrapperConfigSchema.parse({
        servers: { bad: { command: 'npx', url: 'https://example.com' } },
      }),
    ).toThrow();
  });

  it('points a type-less remote entry at the missing type, not at stdio fields', () => {
    expect(() =>
      WrapperConfigSchema.parse({
        servers: { remote: { url: 'https://example.com/mcp', headers: {} } },
      }),
    ).toThrow(/type/);
  });

  it('rejects server names with underscores (reserved for tool namespacing)', () => {
    expect(() =>
      WrapperConfigSchema.parse({
        servers: { bad_name: { command: 'npx' } },
      }),
    ).toThrow();
  });
});
