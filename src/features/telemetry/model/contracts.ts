/** Backpressure tier of the ambilight frame queue. */
export const TELEMETRY_QUEUE_HEALTH = {
  HEALTHY: "healthy",
  WARNING: "warning",
  CRITICAL: "critical",
} as const;

/** One value from {@link TELEMETRY_QUEUE_HEALTH}. */
export type TelemetryQueueHealth =
  (typeof TELEMETRY_QUEUE_HEALTH)[keyof typeof TELEMETRY_QUEUE_HEALTH];

/** USB capture/send FPS and queue health, polled from the Rust runtime. */
export interface RuntimeTelemetrySnapshot {
  captureFps: number;
  sendFps: number;
  queueHealth: TelemetryQueueHealth;
  /** EWMA of capture+send cost in milliseconds. 0 before the first frame. */
  frameLatencyMs: number;
}

/** Pre-formatted, display-ready view of a {@link RuntimeTelemetrySnapshot}. */
export interface RuntimeTelemetryDisplayModel {
  captureFpsText: string;
  sendFpsText: string;
  queueHealthLabel: TelemetryQueueHealth;
}

/** Hue entertainment stream health: state, packet rate, DTLS, and reconnects. */
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

/** Combined USB + Hue telemetry returned by a single poll. */
export interface FullTelemetrySnapshot {
  usb: RuntimeTelemetrySnapshot;
  hue: HueTelemetrySnapshot | null;
}
