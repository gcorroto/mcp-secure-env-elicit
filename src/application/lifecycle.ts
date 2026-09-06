import { type Readable } from 'node:stream';

/**
 * Process-lifetime watchers. A stdio MCP server has no protocol-level
 * "goodbye": the client just goes away. Without something watching for that,
 * a wrapper that holds an open handle (here: the HTTPS sign-in listener)
 * outlives every client and, with short-lived clients, leaks one process per
 * invocation. See https://github.com/gcorroto/mcp-secure-env-elicit/issues/1.
 */
export interface Watcher {
  dispose: () => void;
}

const NO_WATCHER: Watcher = { dispose: () => undefined };

/**
 * Fire `onEof` when stdin reaches EOF — the stdio equivalent of the client
 * hanging up. `StdioServerTransport` (SDK 1.29.0) only subscribes to `'data'`
 * and `'error'`, so nothing else notices.
 *
 * Install this *after* the transport is connected: its `'data'` listener is
 * what puts stdin in flowing mode, which is what makes `'end'` fire. Resuming
 * the stream here instead would drop the client's first messages.
 */
export function watchStdinEof(stream: Readable, onEof: () => void): Watcher {
  let fired = false;
  const fire = (): void => {
    if (fired) {
      return;
    }

    fired = true;
    onEof();
  };

  stream.on('end', fire);
  stream.on('close', fire);

  // Already at EOF (stdin was /dev/null, say): neither event will fire again.
  if (stream.readableEnded || stream.destroyed) {
    queueMicrotask(fire);
  }

  return {
    dispose: () => {
      stream.off('end', fire);
      stream.off('close', fire);
    },
  };
}

/**
 * Does `pid` still exist? Signal 0 performs the permission and existence
 * checks without delivering anything — on Windows too, where libuv maps it to
 * an `OpenProcess` probe. `EPERM` means "exists, but not yours".
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

export type ParentWatchdogOptions = Readonly<{
  /** Parent to watch; defaults to the parent at startup. */
  ppid?: number;
  intervalMs?: number;
  /** Seams for tests. */
  isAlive?: (pid: number) => boolean;
  currentPpid?: () => number;
  onParentGone: () => void;
}>;

/** Default poll interval for the parent watchdog. */
export const PARENT_CHECK_INTERVAL_MS = 5_000;

/**
 * Shut down when the process that started us disappears. Windows has neither
 * `SIGHUP` nor `PDEATHSIG` and does not kill grandchildren, so a client that
 * spawns `npx` (which spawns `cmd.exe`, which spawns us) leaves this process
 * behind; polling the parent is the usual fallback. On POSIX the reparenting
 * to pid 1 is caught by the `currentPpid` check as well.
 *
 * A pid of 0 or 1 means there is no meaningful parent to watch (already
 * orphaned, or a container init), so the watchdog stays off rather than
 * shutting down immediately.
 */
export function watchParentProcess(options: ParentWatchdogOptions): Watcher {
  const {
    ppid = process.ppid,
    intervalMs = PARENT_CHECK_INTERVAL_MS,
    isAlive = processExists,
    currentPpid = () => process.ppid,
    onParentGone,
  } = options;

  if (!Number.isInteger(ppid) || ppid <= 1) {
    return NO_WATCHER;
  }

  const timer = setInterval(() => {
    if (currentPpid() === ppid && isAlive(ppid)) {
      return;
    }

    clearInterval(timer);
    onParentGone();
  }, intervalMs);
  // Never let the watchdog itself be the reason the process stays alive.
  timer.unref();

  return {
    dispose: () => {
      clearInterval(timer);
    },
  };
}
