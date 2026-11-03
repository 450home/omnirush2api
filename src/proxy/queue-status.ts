/**
 * Upstream queue telemetry.
 *
 * While a request waits in the gateway's admission queue, the upstream SSE
 * body carries keep-alive comment frames shaped like:
 *
 *     : queued position=93 eta=220
 *
 * The frames used to be treated as anonymous bytes (only useful for resetting
 * the idle watchdog). They actually carry the queue depth and an ETA in
 * seconds, which is enough to tell "still waiting, but moving" apart from
 * "stuck", and to park an account for exactly as long as upstream asked
 * instead of guessing.
 */

export interface QueueStatus {
  /** 1-based position in the wait queue; `undefined` when not queued. */
  readonly position?: number | undefined;
  /** Estimated seconds until this request is admitted. */
  readonly etaSeconds?: number | undefined;
  /** Wall-clock milliseconds when this snapshot was observed. */
  readonly at: number;
}

const QUEUE_RE = /queued\b[^\r\n]*?position=(\d+)[^\r\n]*?eta=(\d+)/i;
const COMMENT_PREFIX = ":";

/** True when the line is an SSE comment (keep-alive / queue heartbeat). */
export function isSseComment(line: string): boolean {
  return line.trimStart().startsWith(COMMENT_PREFIX);
}

/**
 * Parses a `: queued position=N eta=M` keep-alive comment.
 * Returns null for any other comment (e.g. a bare `:` ping).
 */
export function parseQueueStatus(line: string): QueueStatus | null {
  if (!isSseComment(line)) return null;
  const match = QUEUE_RE.exec(line);
  if (!match) return null;
  const position = Number.parseInt(match[1] ?? "", 10);
  const etaSeconds = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(position) || !Number.isFinite(etaSeconds)) return null;
  return { position, etaSeconds, at: Date.now() };
}

/** Human readable one-liner for logs and /health. */
export function formatQueueStatus(status: QueueStatus | null | undefined): string {
  if (!status) return "not queued";
  const pos = status.position ?? "?";
  const eta = status.etaSeconds ?? "?";
  return `position=${pos} eta=${eta}s`;
}

/**
 * How long to park an account after upstream told us the queue is long.
 *
 * Upstream's ETA is a lower bound (the queue can stall, see the
 * `position=98 eta=0` case), so it is padded and capped: parking an account
 * for an hour because of one optimistic ETA would be worse than retrying.
 */
export function cooldownFromQueue(
  status: QueueStatus | null | undefined,
  options: { readonly minMs?: number; readonly maxMs?: number; readonly padMs?: number } = {}
): number {
  const minMs = options.minMs ?? 5_000;
  const maxMs = options.maxMs ?? 120_000;
  const padMs = options.padMs ?? 5_000;
  const etaMs = (status?.etaSeconds ?? 0) * 1000;
  const target = etaMs + padMs;
  return Math.min(maxMs, Math.max(minMs, target));
}

/** Error codes that mean "the queue timed out", not "the account is broken". */
const QUEUE_TIMEOUT_CODES = new Set([
  "omni_queue_timeout",
  "queue_timeout",
  "queue_full",
  "upstream_queue_timeout",
]);

export function isQueueTimeoutCode(code: string | undefined | null): boolean {
  if (!code) return false;
  const normalized = code.trim().toLowerCase();
  if (QUEUE_TIMEOUT_CODES.has(normalized)) return true;
  return normalized.includes("queue");
}
