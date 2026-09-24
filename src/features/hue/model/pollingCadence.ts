// The bridge-side cadences live in Rust (`commands/hue/health.rs`); what stays
// here is the frontend's own timing.

export const READINESS_STALE_MS = 30_000;
// A rejected status read keeps the store asking whatever state it last held —
// the read failing says nothing about the runtime — retrying at 2, 4, 8, 16,
// then every 30 s until one succeeds.
export const RUNTIME_STATUS_RETRY_BASE_MS = 2_000;
export const RUNTIME_STATUS_RETRY_MAX_MS = 30_000;

export function runtimeStatusRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(RUNTIME_STATUS_RETRY_BASE_MS * 2 ** exponent, RUNTIME_STATUS_RETRY_MAX_MS);
}
// The bridge answers 101 until its link button is pressed, then accepts a
// pairing for 30 s. Re-asking every 2 s for 60 s catches that window even
// when the user is slow to reach the bridge.
export const HUE_PAIRING_POLL_INTERVAL_MS = 2_000;
export const HUE_PAIRING_POLL_WINDOW_MS = 60_000;
