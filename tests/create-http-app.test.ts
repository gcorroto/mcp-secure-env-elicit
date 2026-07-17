import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createHttpApp } from '../src/adapters/http/create-http-app.js';
import { resolveTheme } from '../src/adapters/http/themes.js';
import { createSecretRequestService } from '../src/application/secret-request-service.js';
import { createSecretVault, type SecretVault } from '../src/application/secret-vault.js';

interface Harness {
  base: string;
  vault: SecretVault;
  server: Server;
}

let running: Server | undefined;

async function startHarness(): Promise<Harness> {
  const vault = createSecretVault();
  const service = createSecretRequestService({
    authBaseUrl: 'https://irrelevant',
    client: {
      supportsUrlElicitation: () => false,
      elicitUrl: () => Promise.reject(new Error('unsupported')),
    },
    vault,
    createToken: () => 'tok-http',
  });

  // Mint a pending prompt so /auth?token=tok-http is live.
  await service.requestSecrets('oracle', [
    { name: 'ORACLE_USER', input: 'text', description: 'Schema user' },
    { name: 'ORACLE_PASSWORD', input: 'password' },
  ]);

  const app = createHttpApp({
    auth: service,
    theme: resolveTheme('dark'),
    serviceVersion: '0.0.0-test',
  });

  // Tests exercise the Express app over plain HTTP; TLS is composition-time.
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  running = server;
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { base: `http://127.0.0.1:${String(port)}`, vault, server };
}

afterEach(async () => {
  if (running !== undefined) {
    await new Promise((resolve) => running?.close(resolve));
    running = undefined;
  }
});

describe('createHttpApp', () => {
  it('serves health', async () => {
    const { base } = await startHarness();

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: '0.0.0-test' });
  });

  it('renders the form with typed, autofill-friendly inputs', async () => {
    const { base } = await startHarness();

    const response = await fetch(`${base}/auth?token=tok-http`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<strong>oracle</strong>');
    expect(html).toContain('Schema user');
    expect(html).toContain('name="ORACLE_USER" type="text"');
    expect(html).toContain('autocomplete="section-oracle_user on"');
    expect(html).toContain('name="ORACLE_PASSWORD" type="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).not.toContain('autocomplete="off"');
  });

  it('rejects an unknown token', async () => {
    const { base } = await startHarness();

    const response = await fetch(`${base}/auth?token=wrong`);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Link expired');
  });

  it('stores submitted values in the vault and burns the token', async () => {
    const { base, vault } = await startHarness();

    const response = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: 'tok-http',
        ORACLE_USER: 'scott',
        ORACLE_PASSWORD: 'tiger',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Values saved');
    expect(vault.reveal(['ORACLE_USER', 'ORACLE_PASSWORD'])).toEqual({
      ORACLE_USER: 'scott',
      ORACLE_PASSWORD: 'tiger',
    });

    const reuse = await fetch(`${base}/auth?token=tok-http`);
    expect(reuse.status).toBe(400);
  });

  it('re-renders the form with an error on a partial submit', async () => {
    const { base, vault } = await startHarness();

    const response = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'tok-http', ORACLE_USER: 'scott' }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('All fields are required.');
    expect(vault.has('ORACLE_USER')).toBe(false);

    // The token survives so the operator can complete the form.
    const retry = await fetch(`${base}/auth?token=tok-http`);
    expect(retry.status).toBe(200);
  });
});
