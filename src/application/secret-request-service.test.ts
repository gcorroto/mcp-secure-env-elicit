import { describe, expect, it } from 'vitest';

import { createSecretVault } from './secret-vault.js';
import {
  createSecretRequestService,
  type McpClientBridge,
  type SecretField,
  type SecretRequestService,
} from './secret-request-service.js';

const BASE = 'https://127.0.0.1:3000';

const FIELDS: readonly SecretField[] = [
  { name: 'ORACLE_USER', input: 'text' },
  { name: 'ORACLE_PASSWORD', input: 'password' },
];

/** A sequential, deterministic token generator for tests. */
function sequentialTokens(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `tok${String(n)}`;
  };
}

/**
 * A fake client that, on elicitation, submits the given values through the
 * token embedded in the sign-in URL — mirroring the browser POST to `/auth`.
 */
function autoSubmit(values: Record<string, string>): {
  client: McpClientBridge;
  getCalls: () => number;
  bind: (service: SecretRequestService) => void;
} {
  let calls = 0;
  let bound: SecretRequestService | undefined;
  const client: McpClientBridge = {
    supportsUrlElicitation: () => true,
    elicitUrl: ({ url }) => {
      calls += 1;
      const token = new URL(url).searchParams.get('token');
      if (token !== null && bound !== undefined) {
        bound.submit(token, values);
      }
      return Promise.resolve({ action: 'accept' });
    },
  };
  return {
    client,
    getCalls: () => calls,
    bind: (service) => {
      bound = service;
    },
  };
}

const noElicitation: McpClientBridge = {
  supportsUrlElicitation: () => false,
  elicitUrl: () => Promise.reject(new Error('should not be called')),
};

describe('createSecretRequestService', () => {
  it('prompts once and stores the values in the vault', async () => {
    const vault = createSecretVault();
    const helper = autoSubmit({ ORACLE_USER: 'scott', ORACLE_PASSWORD: 'tiger' });
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: helper.client,
      vault,
      createToken: sequentialTokens(),
    });
    helper.bind(service);

    const first = await service.requestSecrets('oracle', FIELDS);
    expect(first).toEqual({ ok: true });
    expect(vault.reveal(['ORACLE_USER', 'ORACLE_PASSWORD'])).toEqual({
      ORACLE_USER: 'scott',
      ORACLE_PASSWORD: 'tiger',
    });
    expect(helper.getCalls()).toBe(1);

    const second = await service.requestSecrets('oracle', FIELDS);
    expect(second).toEqual({ ok: true });
    expect(helper.getCalls()).toBe(1);
  });

  it('only prompts for the fields that are still missing', async () => {
    const vault = createSecretVault();
    vault.set('ORACLE_USER', 'scott');
    let promptedFields: string[] = [];
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: {
        supportsUrlElicitation: () => true,
        elicitUrl: ({ url }) => {
          const token = new URL(url).searchParams.get('token') ?? '';
          promptedFields = (service.describe(token)?.fields ?? []).map((field) => field.name);
          service.submit(token, { ORACLE_PASSWORD: 'tiger' });
          return Promise.resolve({ action: 'accept' });
        },
      },
      vault,
      createToken: sequentialTokens(),
    });

    const result = await service.requestSecrets('oracle', FIELDS);

    expect(result).toEqual({ ok: true });
    expect(promptedFields).toEqual(['ORACLE_PASSWORD']);
  });

  it('coalesces concurrent requests for the same server onto one prompt', async () => {
    const vault = createSecretVault();
    const helper = autoSubmit({ ORACLE_USER: 'scott', ORACLE_PASSWORD: 'tiger' });
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: helper.client,
      vault,
      createToken: sequentialTokens(),
    });
    helper.bind(service);

    const [a, b] = await Promise.all([
      service.requestSecrets('oracle', FIELDS),
      service.requestSecrets('oracle', FIELDS),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual(a);
    expect(helper.getCalls()).toBe(1);
  });

  it('returns SECRETS_REQUIRED with a sign-in URL when the client lacks url elicitation', async () => {
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: noElicitation,
      vault: createSecretVault(),
      createToken: () => 'abc',
    });

    const result = await service.requestSecrets('oracle', FIELDS);

    expect(result).toMatchObject({
      ok: false,
      code: 'SECRETS_REQUIRED',
      url: `${BASE}/auth?token=abc`,
    });
  });

  it('keeps the token redeemable after returning the URL as text', async () => {
    const vault = createSecretVault();
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: noElicitation,
      vault,
      createToken: () => 'abc',
    });

    await service.requestSecrets('oracle', FIELDS);

    // The tool call has returned, but the operator can still open the link…
    expect(service.describe('abc')).toEqual({ serverName: 'oracle', fields: FIELDS });
    expect(service.submit('abc', { ORACLE_USER: 'scott', ORACLE_PASSWORD: 'tiger' })).toBe(true);
    // …and the retry finds the values without prompting again.
    const retry = await service.requestSecrets('oracle', FIELDS);
    expect(retry).toEqual({ ok: true });
    // The token is single-use.
    expect(service.describe('abc')).toBeUndefined();
    expect(service.submit('abc', { ORACLE_USER: 'x', ORACLE_PASSWORD: 'y' })).toBe(false);
  });

  it('rejects a partial submit and keeps the token alive', async () => {
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: noElicitation,
      vault: createSecretVault(),
      createToken: () => 'abc',
    });

    await service.requestSecrets('oracle', FIELDS);

    expect(service.submit('abc', { ORACLE_USER: 'scott' })).toBe(false);
    expect(service.describe('abc')).toBeDefined();
    expect(service.submit('abc', { ORACLE_USER: 'scott', ORACLE_PASSWORD: 'tiger' })).toBe(true);
  });

  it('expires an unredeemed token once the sign-in window closes', async () => {
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: noElicitation,
      vault: createSecretVault(),
      createToken: () => 'abc',
      requestTimeoutMs: 20,
    });

    await service.requestSecrets('oracle', FIELDS);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(service.describe('abc')).toBeUndefined();
    expect(service.submit('abc', { ORACLE_USER: 'u', ORACLE_PASSWORD: 'p' })).toBe(false);
  });

  it('rejects submissions for unknown tokens', () => {
    const service = createSecretRequestService({
      authBaseUrl: BASE,
      client: noElicitation,
      vault: createSecretVault(),
    });

    expect(service.submit('nope', { A: 'x' })).toBe(false);
    expect(service.describe('nope')).toBeUndefined();
  });
});
