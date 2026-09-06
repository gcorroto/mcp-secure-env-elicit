import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { processExists } from '../src/application/lifecycle.js';
import { killProcessTree } from '../src/application/process-tree.js';

const isWindows = process.platform === 'win32';

let spawned: ChildProcess | undefined;

afterEach(() => {
  spawned?.kill('SIGKILL');
  spawned = undefined;
});

describe('killProcessTree', () => {
  it('kills the whole tree with taskkill /t on Windows', () => {
    const run = vi.fn(() => 0);

    expect(killProcessTree(1234, { platform: 'win32', run })).toBe(true);
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/t', '/f']);
  });

  it('reports failure when the process is already gone', () => {
    const run = vi.fn(() => 128);

    expect(killProcessTree(1234, { platform: 'win32', run })).toBe(false);
  });

  it('is a no-op off Windows, where the SDK signal already reaches the child', () => {
    const run = vi.fn(() => 0);

    expect(killProcessTree(1234, { platform: 'linux', run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores pids that cannot exist', () => {
    const run = vi.fn(() => 0);

    expect(killProcessTree(undefined, { platform: 'win32', run })).toBe(false);
    expect(killProcessTree(0, { platform: 'win32', run })).toBe(false);
    expect(killProcessTree(-1, { platform: 'win32', run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it.runIf(isWindows)('kills a real grandchild that a plain kill() would orphan', async () => {
    // parent (node) → grandchild (node): killing the parent alone leaves the
    // grandchild running on Windows, which is exactly the leak from issue #1.
    const parentScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      process.stdout.write(String(child.pid));
      setInterval(() => {}, 1000);
    `;

    spawned = spawn(process.execPath, ['-e', parentScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      spawned?.stdout?.once('data', (chunk: Buffer) => {
        resolve(Number.parseInt(chunk.toString('utf8').trim(), 10));
      });
      spawned?.once('error', reject);
    });

    expect(processExists(grandchildPid)).toBe(true);

    killProcessTree(spawned.pid);
    await vi.waitFor(() => {
      expect(processExists(grandchildPid)).toBe(false);
    });
  });
});
