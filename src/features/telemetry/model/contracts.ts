export const TELEMETRY_QUEUE_HEALTH = {
  HEALTHY: "healthy",
  WARNING: "warning",
  CRITICAL: "critical",
} as const;

export type TelemetryQueueHealth =
  (typeof TELEMETRY_QUEUE_HEALTH)[keyof typeof TELEMETRY_QUEUE_HEALTH];

export interface RuntimeTelemetrySnapshot {
  captureFps: number;
  sendFps: number;
  queueHealth: TelemetryQueueHealth;
}

export interface RuntimeTelemetryDisplayModel {
  captureFpsText: string;
  sendFpsText: string;
  queueHealthLabel: TelemetryQueueHealth;
}
