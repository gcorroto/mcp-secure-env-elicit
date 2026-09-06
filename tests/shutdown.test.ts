import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { processExists } from '../src/application/lifecycle.js';

/**
 * End-to-end regression test for
 * https://github.com/gcorroto/mcp-secure-env-elicit/issues/1: the wrapper used
 * to survive its MCP client, because the HTTPS sign-in server keeps the event
 * loop alive and nothing watched stdin for the client hanging up. On Windows
 * every short-lived client invocation then leaked a whole process chain.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = join(REPO_ROOT, 'src', 'index.ts');
const CHILD_FIXTURE = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

const EXIT_BUDGET_MS = 15_000;

let workDir: string | undefined;
let wrapper: ChildProcessWithoutNullStreams | undefined;

function writeConfig(pidFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'secure-env-shutdown-'));
  workDir = dir;
  const configPath = join(dir, 'mcp-secure-env.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      servers: {
        echo: {
          command: process.execPath,
          args: [CHILD_FIXTURE],
          env: { FIXTURE_PID_FILE: pidFile },
          autoStart: true,
        },
      },
    }),
    'utf8',
  );
  return configPath;
}

/** Start the wrapper the way an MCP client does: over stdio, on a free port. */
function startWrapper(configPath: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [TSX_CLI, ENTRY, '--config', configPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  wrapper = child;
  return child;
}

/** Resolve once `pattern` shows up on the process' stderr. */
function waitForStderr(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${String(pattern)}. stderr so far:\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      if (pattern.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
    };

    child.stderr.on('data', onData);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Wrapper still running ${String(timeoutMs)}ms after the client left`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Minimal MCP handshake — enough for the wrapper to reach `oninitialized`. */
function handshake(child: ChildProcessWithoutNullStreams): void {
  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shutdown-test', version: '0.0.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

afterEach(() => {
  if (wrapper?.exitCode === null) {
    wrapper.kill('SIGKILL');
  }

  wrapper = undefined;

  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe('wrapper lifetime', () => {
  it('exits when the client closes stdin, taking its child servers with it', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'secure-env-pid-')), 'child.pid');
    const child = startWrapper(writeConfig(pidFile));

    await waitForStderr(child, /sign-in page/);
    handshake(child);
    await waitForStderr(child, /server 'echo' started/);

    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    expect(processExists(childPid)).toBe(true);

    // The client goes away: its end of the pipe closes, nothing else.
    child.stdin.end();

    const code = await waitForExit(child, EXIT_BUDGET_MS);
    expect(code).toBe(0);
    expect(processExists(childPid)).toBe(false);
  }, 60_000);

  it('exits immediately when stdin is at EOF from the start', async () => {
    // The reproduction from the issue: `node dist/index.js --config … < /dev/null`
    // used to stay alive for ever behind the HTTPS sign-in listener.
    const pidFile = join(mkdtempSync(join(tmpdir(), 'secure-env-pid-')), 'child.pid');
    const child = startWrapper(writeConfig(pidFile));

    await waitForStderr(child, /sign-in page/);
    child.stdin.end();

    const code = await waitForExit(child, EXIT_BUDGET_MS);
    expect(code).toBe(0);
  }, 60_000);
});
