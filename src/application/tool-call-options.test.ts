import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_TIMEOUT_MS, toolCallRequestOptions, toolTimeoutFromEnv } from './tool-call-options.js';

describe('proxied tool calls are not cut at the SDK 60 s default', () => {
  it('uses the wrapper timeout, restarted on progress and capped at twice in total', () => {
    expect(toolCallRequestOptions(DEFAULT_TOOL_TIMEOUT_MS)).toEqual({
      timeout: 30 * 60_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 60 * 60_000,
    });
  });

  it('passes the client cancellation and forwards progress', () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const options = toolCallRequestOptions(1000, { signal: controller.signal, onProgress: (p) => seen.push(p) });
    expect(options.signal).toBe(controller.signal);
    options.onprogress?.({ progress: 3, total: 10, message: 'building' });
    options.onprogress?.({ progress: 4 });
    expect(seen).toEqual([{ progress: 3, total: 10, message: 'building' }, { progress: 4 }]);
  });

  it('reads the timeout from the environment, falling back to the default', () => {
    expect(toolTimeoutFromEnv('120000')).toBe(120_000);
    expect(toolTimeoutFromEnv(undefined)).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(toolTimeoutFromEnv('')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(toolTimeoutFromEnv('abc')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(toolTimeoutFromEnv('-5')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });
});
