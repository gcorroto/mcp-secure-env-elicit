import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WrapperConfigSchema } from '../schemas/wrapper-config.js';
import { expandPaths, resolveStdioTemplates } from './placeholders.js';
import { createPathSettings } from './path-settings.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(): {
  dir: string;
  config: ReturnType<typeof WrapperConfigSchema.parse>;
  settings: ReturnType<typeof createPathSettings>;
} {
  const dir = mkdtempSync(join(process.cwd(), '.path-settings-test-'));
  dirs.push(dir);
  const config = WrapperConfigSchema.parse({
    servers: {},
    paths: {
      SESSION: { input: 'path', kind: 'file', default: '${home}/session.json', createParent: true },
    },
  });
  return { dir, config, settings: createPathSettings(config, 'source-a', join(dir, 'settings')) };
}
describe('portable paths', () => {
  it('expands on Windows, macOS and Linux, preserving surrounding text', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const home = platform === 'win32' ? 'C:\\Users\\Ada' : '/home/ada';
      const sep = platform === 'win32' ? '\\' : '/';
      expect(expandPaths('${home}/folder/file', {}, { platform, home })).toBe(
        `${home}${sep}folder${sep}file`,
      );
      expect(expandPaths('~/folder', {}, { platform, home })).toBe(`${home}${sep}folder`);
      expect(expandPaths('prefix=${tmpdir}', {}, { platform, temp: home })).toBe(`prefix=${home}`);
    }
  });
  it('handles missing and empty environment values and fallbacks', () => {
    expect(() => expandPaths('${env:MISSING}', {}, { env: {} })).toThrow("'MISSING'");
    expect(expandPaths('${env:MISSING:-fallback}', {}, { env: {} })).toBe('fallback');
    expect(expandPaths('${env:EMPTY:-fallback}', {}, { env: { EMPTY: '' } })).toBe('fallback');
    expect(expandPaths('${env:EMPTY}', {}, { env: { EMPTY: '' } })).toBe('');
  });
  it('resolves paths and secrets in spawn fields', () => {
    const server = WrapperConfigSchema.parse({
      servers: {
        test: {
          command: 'node',
          args: ['${path:SESSION}', '${secure:TOKEN}'],
          env: { FILE: '${path:SESSION}' },
          cwd: '${home}',
        },
      },
    }).servers.test;
    if (server?.type !== 'stdio') throw new Error('wrong type');
    const resolved = resolveStdioTemplates(server, { TOKEN: 'secret' }, { SESSION: '/tmp/a' });
    expect(resolved.args).toEqual(['/tmp/a', 'secret']);
    expect(resolved.env.FILE).toBe('/tmp/a');
    expect(resolved.cwd).toBeTruthy();
  });
  it('validates schema', () => {
    expect(
      WrapperConfigSchema.safeParse({
        servers: {},
        paths: { X: { input: 'path', kind: 'bad', default: '/a' } },
      }).success,
    ).toBe(false);
  });
  it('persists overrides, isolates sources, validates and creates parents', () => {
    const { dir, config, settings } = setup();
    expect(settings.display().SESSION).not.toContain('${home}');
    expect(() => {
      settings.save({ SESSION: 'relative' });
    }).toThrow('absolute');
    const target = join(dir, 'new', 'session.json');
    settings.save({ SESSION: target });
    const restarted = createPathSettings(config, 'source-a', join(dir, 'settings'));
    expect(restarted.values().SESSION).toBe(target);
    expect(createPathSettings(config, 'source-b', join(dir, 'settings')).values().SESSION).not.toBe(
      target,
    );
    expect(restarted.prepare(['${path:SESSION}']).SESSION).toBe(target);
    expect(existsSync(join(dir, 'new'))).toBe(true);
    expect(() => restarted.prepare(['${path:UNKNOWN}'])).toThrow('UNKNOWN');
  });
  it('reports a parent creation failure before returning spawn parameters', () => {
    const { dir, settings } = setup();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'file');
    settings.save({ SESSION: join(blocker, 'child', 'file.json') });
    expect(() => settings.prepare(['${path:SESSION}'])).toThrow();
  });
});
