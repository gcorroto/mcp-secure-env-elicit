import { spawnSync } from 'node:child_process';

export type ProcessTreeOptions = Readonly<{
  platform?: NodeJS.Platform;
  /** Seam for tests; returns the exit status of the kill command. */
  run?: (command: string, args: readonly string[]) => number | null;
}>;

function runTaskkill(command: string, args: readonly string[]): number | null {
  const result = spawnSync(command, [...args], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000,
  });
  return result.status;
}

/**
 * Kill `pid` and everything it spawned.
 *
 * Windows has no process groups: `ChildProcess.kill()` (what the SDK's stdio
 * transport uses) terminates the child alone, so a child launched through
 * `npx`/`cmd.exe` leaves its own grandchildren running for ever. `taskkill /T`
 * walks the tree instead.
 *
 * On POSIX the SDK's `SIGTERM`/`SIGKILL` already reaches the child and its
 * process group, so this is a no-op there.
 *
 * Returns whether a tree kill was attempted and reported success; a failure is
 * expected and harmless when the process is already gone.
 */
export function killProcessTree(
  pid: number | undefined,
  options: ProcessTreeOptions = {},
): boolean {
  const { platform = process.platform, run = runTaskkill } = options;

  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (platform !== 'win32') {
    return false;
  }

  try {
    return run('taskkill', ['/pid', String(pid), '/t', '/f']) === 0;
  } catch {
    return false;
  }
}
