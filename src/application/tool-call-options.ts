import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';

/**
 * How long a proxied tool call may run before the wrapper gives up on the child.
 *
 * The MCP SDK cuts every request at 60 s unless told otherwise, and the wrapper forwarded child tool calls
 * with no options: any tool that takes longer (waiting for a CI build, a long query, a deployment) failed
 * with "MCP error -32001: Request timed out" while the child kept working. The default is generous; the
 * client still applies its own limit (e.g. Claude Code's MCP_TOOL_TIMEOUT).
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60_000;

/** Progress of a proxied call, as the child reports it. */
export interface ToolProgress {
  progress: number;
  total?: number;
  message?: string;
}

/** What the caller of a proxied tool call can pass along to the child. */
export interface ToolCallOptions {
  /** Aborted when the client cancels the call: the request to the child is cancelled too. */
  signal?: AbortSignal;
  /** Called with the child's progress notifications (forwarded to the client). */
  onProgress?: (progress: ToolProgress) => void;
}

/** The env value as a timeout in ms, or the default when unset or not a positive number. */
export function toolTimeoutFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * The SDK request options for a proxied tool call: the wrapper's timeout, restarted by every progress
 * notification (a long tool that reports progress never expires while it is alive) but never past twice
 * the timeout in total, plus the caller's cancellation and progress callback when it gave them.
 */
export function toolCallRequestOptions(timeoutMs: number, options: ToolCallOptions = {}): RequestOptions {
  const request: RequestOptions = {
    timeout: timeoutMs,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: timeoutMs * 2,
  };
  if (options.signal) request.signal = options.signal;
  const { onProgress } = options;
  if (onProgress) {
    request.onprogress = (p) => {
      const out: ToolProgress = { progress: p.progress };
      if (p.total !== undefined) out.total = p.total;
      if (p.message !== undefined) out.message = p.message;
      onProgress(out);
    };
  }
  return request;
}
