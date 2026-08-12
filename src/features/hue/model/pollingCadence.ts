import type { HueRuntimeStatus } from "@/shared/contracts/hue";

export const READINESS_STALE_MS = 30_000;
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
