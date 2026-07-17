import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** A wrapper config that lives inside a shared git repository. */
export interface GitConfigSource {
  /** Clone URL exactly as git understands it (https, ssh, or a local path). */
  url: string;
  /** Path of the config file inside the repository. */
  filePath: string;
}

export type ConfigSource =
  | Readonly<{ kind: 'file'; path: string }>
  | Readonly<{ kind: 'git'; source: GitConfigSource }>;

export const DEFAULT_REPO_CONFIG_FILE = 'mcp-secure-env.config.json';

/**
 * Interpret the `--config` value. A value that git would clone — `git@…`,
 * `git+…`, or anything whose pre-fragment part ends in `.git` — is a git
 * source; an optional `#path/inside/repo.json` fragment names the file
 * (defaulting to `mcp-secure-env.config.json` at the repo root). Anything
 * else is a plain local file path.
 */
export function parseConfigSource(raw: string, explicitFilePath?: string): ConfigSource {
  const hashIndex = raw.indexOf('#');
  const base = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);

  const isGit = base.startsWith('git@') || base.startsWith('git+') || base.endsWith('.git');
  if (!isGit) {
    return { kind: 'file', path: raw };
  }

  const url = base.startsWith('git+') ? base.slice(4) : base;
  const filePath = fragment !== '' ? fragment : (explicitFilePath ?? DEFAULT_REPO_CONFIG_FILE);
  return { kind: 'git', source: { url, filePath } };
}

function trace(message: string): void {
  process.stderr.write(`[secure-env] ${message}\n`);
}

function runGit(args: readonly string[], cwd?: string): { ok: boolean; detail: string } {
  const result = spawnSync('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    timeout: 120_000,
    // No TTY prompts from a headless MCP process: either the system
    // credential helper (Git Credential Manager, SSH agent) satisfies the
    // auth, or we fail fast with a clear message.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  if (result.error !== undefined) {
    return { ok: false, detail: result.error.message };
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim().split('\n').slice(-3).join(' ');
    return { ok: false, detail: stderr === '' ? `git exited ${String(result.status)}` : stderr };
  }

  return { ok: true, detail: '' };
}

/** A stable, readable cache directory name for a clone URL. */
function cacheDirFor(url: string, cacheRoot: string): string {
  const slug = basename(url, '.git')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return join(cacheRoot, `${slug === '' ? 'repo' : slug}-${hash}`);
}

/** Fire-and-forget refresh of a cached clone, for the NEXT start. */
function refreshInBackground(dir: string): void {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const fetch = spawn('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], {
    cwd: dir,
    stdio: 'ignore',
    env,
  });
  fetch.on('error', () => undefined);
  fetch.on('exit', (code) => {
    if (code !== 0) {
      trace('could not refresh the config repo; the cached copy stays in use');
      return;
    }

    const reset = spawn('git', ['reset', '--hard', 'FETCH_HEAD'], {
      cwd: dir,
      stdio: 'ignore',
      env,
    });
    reset.on('error', () => undefined);
    reset.unref();
  });
  fetch.unref();
}

/**
 * Ensure a local copy of the shared config repository and return the absolute
 * path of the config file inside it.
 *
 * The clone uses the system `git`, so authentication rides on whatever the
 * developer already has — Git Credential Manager, SSH keys, cached HTTPS
 * credentials — no extra tokens. The default branch is used (that is what a
 * fresh `git clone` checks out).
 *
 * Only the first-ever start pays for the network: when a cached clone
 * exists it is used immediately and refreshed in the background, so config
 * changes land on the next start and startup stays fast enough for MCP
 * client connect timeouts. Offline machines simply keep the cache.
 */
export function fetchGitConfig(
  source: GitConfigSource,
  cacheRoot: string,
  refresh: 'background' | 'blocking' = 'background',
): string {
  const dir = cacheDirFor(source.url, cacheRoot);

  if (!existsSync(join(dir, '.git'))) {
    trace(`cloning config repo ${source.url}`);
    const clone = runGit(['clone', '--depth', '1', source.url, dir]);
    if (!clone.ok) {
      throw new Error(
        `Could not clone the config repo '${source.url}': ${clone.detail}. ` +
          `Check that you have access with your system git credentials ` +
          `(try 'git clone ${source.url}' in a terminal once).`,
      );
    }
  } else if (refresh === 'background') {
    refreshInBackground(dir);
  } else {
    // Blocking refresh (tests and callers that need the tip right now).
    const fetch = runGit(['fetch', '--depth', '1', 'origin', 'HEAD'], dir);
    const reset = fetch.ok ? runGit(['reset', '--hard', 'FETCH_HEAD'], dir) : fetch;
    if (!reset.ok) {
      trace(`could not refresh config repo (${reset.detail}); using the cached copy`);
    }
  }

  const filePath = resolve(dir, source.filePath);
  if (!filePath.startsWith(resolve(dir))) {
    throw new Error(`Config file path '${source.filePath}' escapes the repository`);
  }

  if (!existsSync(filePath)) {
    throw new Error(
      `Config file '${source.filePath}' not found in ${source.url}. ` +
        `Name it with a fragment: --config ${source.url}#path/to/config.json`,
    );
  }

  return filePath;
}
