import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createChildServerManager,
  type ChildServerManager,
} from '../src/application/child-server-manager.js';
import { createSecretRequestService } from '../src/application/secret-request-service.js';
import { createSecretVault, type SecretVault } from '../src/application/secret-vault.js';
import { WrapperConfigSchema, type WrapperConfig } from '../src/schemas/wrapper-config.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

function fixtureConfig(): WrapperConfig {
  return WrapperConfigSchema.parse({
    servers: {
      echo: {
        command: process.execPath,
        args: [FIXTURE],
        env: { FIXTURE_SECRET: '${secure:FIXTURE_SECRET}' },
      },
    },
    secrets: {
      FIXTURE_SECRET: { description: 'Secret handed to the fixture' },
    },
  });
}

function buildManager(vault: SecretVault): ChildServerManager {
  const secretRequests = createSecretRequestService({
    authBaseUrl: 'https://127.0.0.1:48910',
    client: {
      supportsUrlElicitation: () => false,
      elicitUrl: () => Promise.reject(new Error('unsupported')),
    },
    vault,
    createToken: () => 'tok-test',
  });

  return createChildServerManager({ config: fixtureConfig(), vault, secretRequests });
}

let manager: ChildServerManager | undefined;

afterEach(async () => {
  await manager?.stopAll();
  manager = undefined;
});

describe('createChildServerManager', () => {
  it('starts a child, proxies its tools, and injects the resolved secret', async () => {
    const vault = createSecretVault();
    vault.set('FIXTURE_SECRET', 's3cret-value');
    manager = buildManager(vault);

    const result = await manager.ensureStarted('echo');
    expect(result).toMatchObject({ ok: true, serverName: 'echo', tools: ['echo__echo'] });

    const tools = manager.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo__echo']);

    const call = (await manager.callTool('echo__echo', { message: 'hola' })) as {
      content: { type: string; text: string }[];
    };
    expect(JSON.parse(call.content[0]?.text ?? '{}')).toEqual({
      message: 'hola',
      secret: 's3cret-value',
    });

    const status = manager.status();
    expect(status).toMatchObject([
      { name: 'echo', state: 'running', missingSecrets: [], toolCount: 1 },
    ]);
  });

  it('is idempotent for an already-running child', async () => {
    const vault = createSecretVault();
    vault.set('FIXTURE_SECRET', 'x');
    manager = buildManager(vault);

    await manager.ensureStarted('echo');
    const again = await manager.ensureStarted('echo');

    expect(again).toMatchObject({ ok: true, alreadyRunning: true });
  });

  it('returns SECRETS_REQUIRED with the sign-in URL when secrets are missing', async () => {
    const vault = createSecretVault();
    manager = buildManager(vault);

    const result = await manager.ensureStarted('echo');

    expect(result).toMatchObject({
      ok: false,
      code: 'SECRETS_REQUIRED',
      url: 'https://127.0.0.1:48910/auth?token=tok-test',
    });
    expect(manager.listTools()).toEqual([]);
    expect(manager.status()).toMatchObject([
      {
        name: 'echo',
        state: 'stopped',
        missingSecrets: ['FIXTURE_SECRET'],
        signInUrl: 'https://127.0.0.1:48910/auth?token=tok-test',
      },
    ]);
  });

  it('stops a child and drops its tools', async () => {
    const vault = createSecretVault();
    vault.set('FIXTURE_SECRET', 'x');
    manager = buildManager(vault);

    await manager.ensureStarted('echo');
    expect(await manager.stop('echo')).toBe(true);
    expect(manager.listTools()).toEqual([]);
    expect(await manager.stop('echo')).toBe(false);

    await expect(manager.callTool('echo__echo', {})).rejects.toThrow("not running");
  });

  it('rejects unknown servers and malformed tool names', async () => {
    const vault = createSecretVault();
    manager = buildManager(vault);

    await expect(manager.ensureStarted('nope')).rejects.toThrow("Unknown server 'nope'");
    await expect(manager.callTool('no-separator', {})).rejects.toThrow('Unknown tool');
  });
});
