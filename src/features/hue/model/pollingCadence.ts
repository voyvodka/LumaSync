import type { HueRuntimeStatus } from "@/shared/contracts/hue";

export const READINESS_STALE_MS = 30_000;
/** Bridge-reachability probe cadence while Hue is configured but not streaming. */
export const HUE_BRIDGE_REACHABILITY_POLL_MS = 30_000;
export const READINESS_BACKGROUND_REFRESH_MS = 15_000;
// Tighter cadence used while the selected area is blocked by another
// active streamer. The user is actively waiting for the foreign session
// to release, so polling every 3 s keeps the banner from feeling stuck.
// Once the area becomes free, we fall back to the regular 15 s cadence.
export const READINESS_BLOCKED_REFRESH_MS = 3_000;
// Backend `spawn_reconnect_monitor` (`src-tauri/src/commands/hue/reconnect.rs`)
// already polls the DTLS sender's shutdown signal every 200 ms and flips the
// runtime state on its own — this frontend poll is a visual-reflection
// concern only, so a tight 3 s cadence is wasteful HTTPS traffic to the
// Bridge while the stream is alive. 10 s keeps the Devices-tab badge fresh
// without piling redundant readiness GETs onto the live DTLS frame stream.
export const RUNTIME_POLL_INTERVAL_MS = 10_000;
// Floor between two runtime-status reads however they are triggered. Without
// it every state transition (and every visibility resume) fired an immediate
// bridge round-trip, so a Idle→Starting→Running burst cost three.
export const RUNTIME_POLL_MIN_INTERVAL_MS = 1_500;
// A rejected status read keeps the loop alive whatever state it last held —
// the read failing says nothing about the runtime — retrying at 2, 4, 8, 16,
// then every 30 s until one succeeds.
export const RUNTIME_STATUS_RETRY_BASE_MS = 2_000;
export const RUNTIME_STATUS_RETRY_MAX_MS = 30_000;

export function runtimeStatusRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(RUNTIME_STATUS_RETRY_BASE_MS * 2 ** exponent, RUNTIME_STATUS_RETRY_MAX_MS);
}
// Runtime states for which polling makes sense — the stream is alive (or
// trying to be), so the readiness probe / dead-sender check carry signal.
// In Idle / Stopping / Failed the backend snapshot is fully owned by the
// state machine; redundant polling just churns IPC and causes pointless
// Devices-tab re-renders.
export const STREAMING_RUNTIME_STATES = new Set<HueRuntimeStatus["state"]>([
  "Starting",
  "Running",
  "Reconnecting",
]);
// The bridge answers 101 until its link button is pressed, then accepts a
// pairing for 30 s. Re-asking every 2 s for 60 s catches that window even
// when the user is slow to reach the bridge.
export const HUE_PAIRING_POLL_INTERVAL_MS = 2_000;
export const HUE_PAIRING_POLL_WINDOW_MS = 60_000;
