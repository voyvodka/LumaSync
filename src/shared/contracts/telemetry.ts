// `get_runtime_telemetry` contracts. Rust handoff:
// `src-tauri/src/commands/runtime_telemetry.rs` — field parity is verified.

/** How close the capture-to-output queue is to falling behind. */
export const TELEMETRY_QUEUE_HEALTH = {
  HEALTHY: "healthy",
  WARNING: "warning",
  CRITICAL: "critical",
} as const;

export type TelemetryQueueHealth =
  (typeof TELEMETRY_QUEUE_HEALTH)[keyof typeof TELEMETRY_QUEUE_HEALTH];

/**
 * Sentinel for `linkMaxFps` meaning "no serial link in play" (Hue-only session,
 * or before the first worker start) — NOT a measured zero.
 */
export const LINK_MAX_FPS_ABSENT = 0;

/**
 * `linkConstrained` threshold, mirroring `LINK_CONSTRAINED_FPS` in
 * `lighting_mode.rs`. Deliberately distinct from `exceeds_link_budget`, which is
 * stricter and drives the send-rate clamp without implying user-visible damage.
 */
export const LINK_CONSTRAINED_FPS_THRESHOLD = 30;

/** Per-frame USB serial link performance snapshot, sampled for the telemetry HUD. */
export interface RuntimeTelemetrySnapshot {
  captureFps: number;
  sendFps: number;
  queueHealth: TelemetryQueueHealth;
  /** EWMA of capture+send cost in milliseconds. 0 before the first frame. */
  frameLatencyMs: number;
  /**
   * The serial link **materially degrades** the effect (`linkMaxFps` below
   * {@link LINK_CONSTRAINED_FPS_THRESHOLD}) — not merely "at capacity".
   */
  linkConstrained: boolean;
  /**
   * Frames per second the serial link can physically carry for this strip.
   * {@link LINK_MAX_FPS_ABSENT} means absent — render it as such, never `0 fps`.
   */
  linkMaxFps: number;
}

/** Per-frame Hue entertainment stream health snapshot, sampled for the telemetry HUD. */
export interface HueTelemetrySnapshot {
  state: string;
  uptimeSecs: number | null;
  packetRate: number;
  lastErrorCode: string | null;
  lastErrorAtSecs: number | null;
  totalReconnects: number;
  successfulReconnects: number;
  failedReconnects: number;
  dtlsActive: boolean;
  dtlsCipher: string | null;
  dtlsConnectedAtSecs: number | null;
}

/** Combined USB + Hue telemetry returned by `get_runtime_telemetry`. */
export interface FullTelemetrySnapshot {
  usb: RuntimeTelemetrySnapshot;
  /** `null` until Hue has been active at least once this session. */
  hue: HueTelemetrySnapshot | null;
}

/** False for Hue-only sessions, where `linkMaxFps` carries no measurement. */
export function hasSerialLinkBudget(snapshot: RuntimeTelemetrySnapshot): boolean {
  return snapshot.linkMaxFps > LINK_MAX_FPS_ABSENT;
}
