import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPathSettings } from '../../application/path-settings.js';
import { WrapperConfigSchema } from '../../schemas/wrapper-config.js';
import { createHttpApp } from './create-http-app.js';
import { resolveTheme } from './themes.js';

describe('local path form', () => {
  it('displays defaults and saves validated overrides independently of secrets', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.path-form-test-'));
    const config = WrapperConfigSchema.parse({
      servers: {},
      paths: { FILE: { input: 'path', kind: 'file', default: '${home}/test.json' } },
    });
    const settings = createPathSettings(config, 'source', dir);
    let secretSubmissions = 0;
    const app = createHttpApp({
      auth: {
        describe: () => undefined,
        submit: () => {
          secretSubmissions++;
          return true;
        },
      },
      theme: resolveTheme(undefined),
      serviceVersion: 'test',
      pathSettings: settings,
      pathToken: 'token',
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => {
        server.once('listening', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No address');
      const url = `http://127.0.0.1:${String(address.port)}/paths`;
      const html = await (await fetch(`${url}?token=token`)).text();
      expect(html).toContain('type="text"');
      expect(html).toContain(settings.values().FILE);
      const submit = async (value: string): Promise<Response> =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: 'token', FILE: value }),
        });
      expect((await submit('relative')).status).toBe(400);
      const target = join(dir, 'override.json');
      expect((await submit(target)).status).toBe(200);
      expect(createPathSettings(config, 'source', dir).values().FILE).toBe(target);
      expect(secretSubmissions).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
