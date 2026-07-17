import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

import { generateSelfSignedCert } from '../src/adapters/http/tls.js';
import {
  createChildServerManager,
  type ChildServerManager,
} from '../src/application/child-server-manager.js';
import {
  createSecretRequestService,
  type SecretRequestService,
} from '../src/application/secret-request-service.js';
import { createSecretVault, type SecretVault } from '../src/application/secret-vault.js';
import { WrapperConfigSchema, type WrapperConfig } from '../src/schemas/wrapper-config.js';

interface Fixture {
  base: string;
  seenApiKeys: (string | undefined)[];
  /** POSTs that hit the /sse path (the streamable-first attempt) — SSE fixture only. */
  streamableAttempts: number;
  close: () => Promise<void>;
}

function buildMcpFixture(): McpServer {
  const server = new McpServer({ name: 'remote-fixture', version: '0.0.1' });
  server.registerTool('ping', { description: 'Reply pong.', inputSchema: {} }, () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

function listen(server: HttpServer, scheme: 'http' | 'https'): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`${scheme}://127.0.0.1:${String(port)}`);
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

/** A Streamable HTTP MCP endpoint at `/mcp`, capturing X-Api-Key headers. */
async function startStreamableFixture(tls?: { key: string; cert: string }): Promise<Fixture> {
  const mcp = buildMcpFixture();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcp.connect(transport as unknown as Transport);

  const seenApiKeys: (string | undefined)[] = [];

  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    seenApiKeys.push(req.headers['x-api-key'] as string | undefined);
    void transport.handleRequest(req, res);
  };

  const server =
    tls === undefined
      ? createHttpServer(requestListener)
      : (createHttpsServer({ key: tls.key, cert: tls.cert }, requestListener) as HttpServer);
  const base = await listen(server, tls === undefined ? 'http' : 'https');

  return {
    base,
    seenApiKeys,
    streamableAttempts: 0,
    close: async () => {
      await transport.close().catch(() => undefined);
      await closeServer(server);
    },
  };
}

/** A legacy SSE MCP endpoint: GET `/sse` opens the stream, POST `/messages`. */
async function startSseFixture(tls?: { key: string; cert: string }): Promise<Fixture> {
  const mcp = buildMcpFixture();
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const sessions = new Map<string, SSEServerTransport>();
  const seenApiKeys: (string | undefined)[] = [];

  const fixture: Fixture = {
    base: '',
    seenApiKeys,
    streamableAttempts: 0,
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      await closeServer(server);
    },
  };

  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/sse') {
      seenApiKeys.push(req.headers['x-api-key'] as string | undefined);
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      void mcp.connect(transport);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (transport === undefined) {
        res.writeHead(404).end();
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }

    // POSTing the streamable-http initialize to /sse lands here: count it (it
    // is how tests pin the streamable-first ordering) and reject it so
    // clients in fallback mode move on to the SSE transport.
    if (req.method === 'POST' && url.pathname === '/sse') {
      fixture.streamableAttempts += 1;
    }
    res.writeHead(405).end();
  };

  const server =
    tls === undefined
      ? createHttpServer(requestListener)
      : (createHttpsServer({ key: tls.key, cert: tls.cert }, requestListener) as HttpServer);
  fixture.base = await listen(server, tls === undefined ? 'http' : 'https');

  return fixture;
}

function buildManager(
  vault: SecretVault,
  config: WrapperConfig,
): { manager: ChildServerManager; service: SecretRequestService } {
  const service = createSecretRequestService({
    authBaseUrl: 'https://127.0.0.1:48910',
    client: {
      supportsUrlElicitation: () => false,
      elicitUrl: () => Promise.reject(new Error('unsupported')),
    },
    vault,
    createToken: () => 'tok-remote',
  });

  return { manager: createChildServerManager({ config, vault, secretRequests: service }), service };
}

let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) {
    await fn();
  }
  cleanup = [];
});

describe('remote child servers', () => {
  it('connects over streamable http with resolved secret headers', async () => {
    const fixture = await startStreamableFixture();
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    vault.set('API_KEY', 'k-123');
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          api: {
            type: 'http',
            url: `${fixture.base}/mcp`,
            headers: { 'X-Api-Key': '${secure:API_KEY}' },
          },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    const result = await manager.ensureStarted('api');
    expect(result).toMatchObject({ ok: true, tools: ['api__ping'] });

    const call = (await manager.callTool('api__ping', {})) as {
      content: { type: string; text: string }[];
    };
    expect(call.content[0]?.text).toBe('pong');
    expect(fixture.seenApiKeys.every((value) => value === 'k-123')).toBe(true);
    expect(fixture.seenApiKeys.length).toBeGreaterThan(0);
    expect(manager.status()[0]).toMatchObject({ name: 'api', state: 'running', transport: 'http' });
  });

  it('elicits missing secrets lazily, then starts after the submit', async () => {
    const fixture = await startStreamableFixture();
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    const { manager, service } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          api: {
            type: 'http',
            url: `${fixture.base}/mcp`,
            headers: { 'X-Api-Key': '${secure:API_KEY}' },
          },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    // First start: no secrets in the vault → sign-in URL, nothing connected.
    const first = await manager.ensureStarted('api');
    expect(first).toMatchObject({
      ok: false,
      code: 'SECRETS_REQUIRED',
      url: 'https://127.0.0.1:48910/auth?token=tok-remote',
    });
    expect(fixture.seenApiKeys).toEqual([]);

    // The operator submits through the (still valid) token; the retry connects.
    expect(service.submit('tok-remote', { API_KEY: 'late-key' })).toBe(true);
    const retry = await manager.ensureStarted('api');
    expect(retry).toMatchObject({ ok: true, tools: ['api__ping'] });
    expect(fixture.seenApiKeys.every((value) => value === 'late-key')).toBe(true);
  });

  it('connects over legacy SSE, sending headers on the stream request too', async () => {
    const fixture = await startSseFixture();
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    vault.set('API_KEY', 'sse-key');
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          db: {
            type: 'sse',
            url: `${fixture.base}/sse`,
            headers: { 'X-Api-Key': '${secure:API_KEY}' },
          },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    const result = await manager.ensureStarted('db');
    expect(result).toMatchObject({ ok: true, tools: ['db__ping'] });

    const call = (await manager.callTool('db__ping', {})) as {
      content: { type: string; text: string }[];
    };
    expect(call.content[0]?.text).toBe('pong');
    expect(fixture.seenApiKeys).toEqual(['sse-key']);
    // Type 'sse' must go straight to SSE — no streamable attempt.
    expect(fixture.streamableAttempts).toBe(0);
  });

  it('falls back from streamable http to SSE for type https, streamable first', async () => {
    const fixture = await startSseFixture();
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: { legacy: { type: 'https', url: `${fixture.base}/sse` } },
      }),
    );
    cleanup.push(() => manager.stopAll());

    const result = await manager.ensureStarted('legacy');
    expect(result).toMatchObject({ ok: true, tools: ['legacy__ping'] });
    // The contract: streamable http was attempted (POST to /sse → 405) before
    // falling back to the SSE transport.
    expect(fixture.streamableAttempts).toBeGreaterThanOrEqual(1);
  });

  it('honours insecureTls for self-signed streamable endpoints', async () => {
    const tls = await generateSelfSignedCert('127.0.0.1');
    const fixture = await startStreamableFixture(tls);
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          trusted: { type: 'http', url: `${fixture.base}/mcp`, insecureTls: true },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    const result = await manager.ensureStarted('trusted');
    expect(result).toMatchObject({ ok: true, tools: ['trusted__ping'] });
  });

  it('honours insecureTls for self-signed SSE endpoints', async () => {
    const tls = await generateSelfSignedCert('127.0.0.1');
    const fixture = await startSseFixture(tls);
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          trusted: { type: 'sse', url: `${fixture.base}/sse`, insecureTls: true },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    const result = await manager.ensureStarted('trusted');
    expect(result).toMatchObject({ ok: true, tools: ['trusted__ping'] });
  });

  it('rejects self-signed remote endpoints without insecureTls', async () => {
    const tls = await generateSelfSignedCert('127.0.0.1');
    const fixture = await startStreamableFixture(tls);
    cleanup.push(fixture.close);

    const vault = createSecretVault();
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          strict: { type: 'sse', url: `${fixture.base}/mcp` },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    await expect(manager.ensureStarted('strict')).rejects.toThrow('failed to start');
    expect(manager.status()[0]).toMatchObject({ name: 'strict', state: 'error' });
  });

  it('never leaks secret values through failed-start errors or status', async () => {
    const secret = 'hunter2-SUPER-SECRET';
    const vault = createSecretVault();
    vault.set('PW', secret);
    // Placeholder in the userinfo position: fetch itself rejects
    // credential-bearing URLs with a message embedding the resolved URL.
    const { manager } = buildManager(
      vault,
      WrapperConfigSchema.parse({
        servers: {
          leaky: { type: 'http', url: 'https://svc:${secure:PW}@127.0.0.1:9/mcp' },
        },
      }),
    );
    cleanup.push(() => manager.stopAll());

    let thrown = '';
    try {
      await manager.ensureStarted('leaky');
    } catch (error: unknown) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).toContain('failed to start');
    expect(thrown).not.toContain(secret);
    expect(thrown).not.toContain(encodeURIComponent(secret));
    const status = JSON.stringify(manager.status());
    expect(status).not.toContain(secret);
    expect(status).not.toContain(encodeURIComponent(secret));
  });
});
