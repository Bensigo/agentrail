import type { ReplayEvent } from "../../../../../../../lib/replay";

const DOT_COLORS = {
  normal: "var(--green-09)",
  retry: "var(--orange-09)",
  digestMismatch: "var(--red-09)",
} as const;

export function formatReplayDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function replayDotColor(
  event: Pick<ReplayEvent, "is_digest_mismatch" | "is_retry">
): string {
  if (event.is_digest_mismatch) return DOT_COLORS.digestMismatch;
  if (event.is_retry) return DOT_COLORS.retry;
  return DOT_COLORS.normal;
}
