import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processExists, watchParentProcess, watchStdinEof } from '../src/application/lifecycle.js';

describe('watchStdinEof', () => {
  it('fires once when the stream reaches EOF', async () => {
    const stream = new PassThrough();
    const onEof = vi.fn();
    watchStdinEof(stream, onEof);

    stream.resume();
    stream.end();
    await new Promise((resolve) => stream.once('close', resolve));

    expect(onEof).toHaveBeenCalledTimes(1);
  });

  it('fires when the stream is already ended by the time it is installed', async () => {
    const stream = new PassThrough();
    stream.resume();
    stream.end();
    await new Promise((resolve) => stream.once('close', resolve));

    const onEof = vi.fn();
    watchStdinEof(stream, onEof);
    await Promise.resolve();

    expect(onEof).toHaveBeenCalledTimes(1);
  });

  it('does not fire after dispose', async () => {
    const stream = new PassThrough();
    const onEof = vi.fn();
    watchStdinEof(stream, onEof).dispose();

    stream.resume();
    stream.end();
    await new Promise((resolve) => stream.once('close', resolve));

    expect(onEof).not.toHaveBeenCalled();
  });

  it('stays quiet while the stream is open', () => {
    const stream = new PassThrough();
    const onEof = vi.fn();
    watchStdinEof(stream, onEof);

    stream.write('{"jsonrpc":"2.0"}');

    expect(onEof).not.toHaveBeenCalled();
  });
});

describe('processExists', () => {
  it('sees this very process', () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it('does not see an unused pid', () => {
    // 0x7fffffff is above every platform's pid_max, so it can never be live.
    expect(processExists(0x7fff_ffff)).toBe(false);
  });
});

describe('watchParentProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shuts down once the parent is gone', () => {
    const onParentGone = vi.fn();
    let alive = true;
    watchParentProcess({
      ppid: 4242,
      intervalMs: 1_000,
      isAlive: () => alive,
      currentPpid: () => 4242,
      onParentGone,
    });

    vi.advanceTimersByTime(3_000);
    expect(onParentGone).not.toHaveBeenCalled();

    alive = false;
    vi.advanceTimersByTime(1_000);
    expect(onParentGone).toHaveBeenCalledTimes(1);

    // The interval is cleared on the first hit, so it never fires twice.
    vi.advanceTimersByTime(10_000);
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it('treats POSIX reparenting to init as the parent being gone', () => {
    const onParentGone = vi.fn();
    let ppid = 4242;
    watchParentProcess({
      ppid: 4242,
      intervalMs: 1_000,
      isAlive: () => true,
      currentPpid: () => ppid,
      onParentGone,
    });

    ppid = 1;
    vi.advanceTimersByTime(1_000);

    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it('stays off when there is no parent worth watching', () => {
    const onParentGone = vi.fn();
    const isAlive = vi.fn(() => false);

    watchParentProcess({ ppid: 1, intervalMs: 1_000, isAlive, onParentGone });
    watchParentProcess({ ppid: 0, intervalMs: 1_000, isAlive, onParentGone });

    vi.advanceTimersByTime(10_000);

    expect(isAlive).not.toHaveBeenCalled();
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it('stops polling after dispose', () => {
    const onParentGone = vi.fn();
    const watcher = watchParentProcess({
      ppid: 4242,
      intervalMs: 1_000,
      isAlive: () => false,
      currentPpid: () => 4242,
      onParentGone,
    });

    watcher.dispose();
    vi.advanceTimersByTime(10_000);

    expect(onParentGone).not.toHaveBeenCalled();
  });
});
