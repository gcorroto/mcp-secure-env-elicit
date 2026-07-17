import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_REPO_CONFIG_FILE,
  fetchGitConfig,
  parseConfigSource,
} from '../src/application/git-config.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Create a local git repo that acts as the shared config "remote". */
function createOriginRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'secure-env-origin-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function tempCacheRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'secure-env-cache-'));
  cleanups.push(dir);
  return dir;
}

describe('parseConfigSource', () => {
  it('treats plain paths as local files', () => {
    expect(parseConfigSource('C:/workspaces/config.json')).toEqual({
      kind: 'file',
      path: 'C:/workspaces/config.json',
    });
  });

  it('detects git urls and defaults the file name', () => {
    expect(parseConfigSource('https://git.example.com/org/configs.git')).toEqual({
      kind: 'git',
      source: { url: 'https://git.example.com/org/configs.git', filePath: DEFAULT_REPO_CONFIG_FILE },
    });
  });

  it('reads the file path from the fragment', () => {
    expect(parseConfigSource('https://git.example.com/org/configs.git#teams/backend.json')).toEqual(
      {
        kind: 'git',
        source: { url: 'https://git.example.com/org/configs.git', filePath: 'teams/backend.json' },
      },
    );
  });

  it('honours an explicit --config-file when there is no fragment', () => {
    expect(
      parseConfigSource('git@git.example.com:org/configs.git', 'teams/backend.json'),
    ).toEqual({
      kind: 'git',
      source: { url: 'git@git.example.com:org/configs.git', filePath: 'teams/backend.json' },
    });
  });

  it('strips the git+ prefix', () => {
    expect(parseConfigSource('git+https://git.example.com/org/configs.git')).toMatchObject({
      kind: 'git',
      source: { url: 'https://git.example.com/org/configs.git' },
    });
  });
});

describe('fetchGitConfig', () => {
  it('clones the repo and returns the config path', () => {
    const origin = createOriginRepo({ [DEFAULT_REPO_CONFIG_FILE]: '{"servers":{}}' });
    cleanups.push(origin);
    const cacheRoot = tempCacheRoot();

    const path = fetchGitConfig({ url: origin, filePath: DEFAULT_REPO_CONFIG_FILE }, cacheRoot);

    expect(readFileSync(path, 'utf8')).toBe('{"servers":{}}');
  });

  it('refreshes an existing clone to the remote tip (blocking mode)', () => {
    const origin = createOriginRepo({ [DEFAULT_REPO_CONFIG_FILE]: '{"v":1}' });
    cleanups.push(origin);
    const cacheRoot = tempCacheRoot();
    const source = { url: origin, filePath: DEFAULT_REPO_CONFIG_FILE };

    fetchGitConfig(source, cacheRoot);
    writeFileSync(join(origin, DEFAULT_REPO_CONFIG_FILE), '{"v":2}');
    git(origin, 'commit', '-am', 'update');

    const path = fetchGitConfig(source, cacheRoot, 'blocking');

    expect(readFileSync(path, 'utf8')).toBe('{"v":2}');
  });

  it('returns the cache immediately and refreshes in the background by default', async () => {
    const origin = createOriginRepo({ [DEFAULT_REPO_CONFIG_FILE]: '{"v":1}' });
    cleanups.push(origin);
    const cacheRoot = tempCacheRoot();
    const source = { url: origin, filePath: DEFAULT_REPO_CONFIG_FILE };

    fetchGitConfig(source, cacheRoot);
    writeFileSync(join(origin, DEFAULT_REPO_CONFIG_FILE), '{"v":2}');
    git(origin, 'commit', '-am', 'update');

    // Immediate return with the cached content — the refresh has not landed.
    const path = fetchGitConfig(source, cacheRoot);
    expect(readFileSync(path, 'utf8')).toBe('{"v":1}');

    // The background refresh converges for the next start.
    const deadline = Date.now() + 10_000;
    while (readFileSync(path, 'utf8') !== '{"v":2}' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(readFileSync(path, 'utf8')).toBe('{"v":2}');
  });

  it('falls back to the cached copy when the remote is unreachable', () => {
    const origin = createOriginRepo({ [DEFAULT_REPO_CONFIG_FILE]: '{"v":1}' });
    const cacheRoot = tempCacheRoot();
    const source = { url: origin, filePath: DEFAULT_REPO_CONFIG_FILE };

    fetchGitConfig(source, cacheRoot);
    rmSync(origin, { recursive: true, force: true, maxRetries: 3 });

    const path = fetchGitConfig(source, cacheRoot, 'blocking');

    expect(readFileSync(path, 'utf8')).toBe('{"v":1}');
  });

  it('fails with a clear message when the file is missing from the repo', () => {
    const origin = createOriginRepo({ 'other.json': '{}' });
    cleanups.push(origin);

    expect(() =>
      fetchGitConfig({ url: origin, filePath: 'missing.json' }, tempCacheRoot()),
    ).toThrow(/missing\.json.*not found/);
  });

  it('fails with a clear message when the clone itself fails', () => {
    expect(() =>
      fetchGitConfig(
        { url: join(tmpdir(), 'secure-env-does-not-exist.git'), filePath: 'x.json' },
        tempCacheRoot(),
      ),
    ).toThrow(/Could not clone/);
  });

  it('rejects file paths that escape the repository', () => {
    const origin = createOriginRepo({ [DEFAULT_REPO_CONFIG_FILE]: '{}' });
    cleanups.push(origin);

    expect(() =>
      fetchGitConfig({ url: origin, filePath: '../outside.json' }, tempCacheRoot()),
    ).toThrow(/escapes/);
  });
});
