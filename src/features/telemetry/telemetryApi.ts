import { invoke } from "@tauri-apps/api/core";

import { DEVICE_COMMANDS } from "../../shared/contracts/device";
import { TELEMETRY_QUEUE_HEALTH, type RuntimeTelemetrySnapshot } from "./model/contracts";

interface RuntimeTelemetrySnapshotDto {
  captureFps: number;
  sendFps: number;
  queueHealth: string;
}

export type TelemetryInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: TelemetryInvoker = (command, payload) => invoke(command, payload);

function normalizeFps(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, value);
}

function normalizeQueueHealth(value: unknown): RuntimeTelemetrySnapshot["queueHealth"] {
  if (value === TELEMETRY_QUEUE_HEALTH.WARNING || value === TELEMETRY_QUEUE_HEALTH.CRITICAL) {
    return value;
  }

  return TELEMETRY_QUEUE_HEALTH.HEALTHY;
}

export function mapRuntimeTelemetrySnapshot(dto: RuntimeTelemetrySnapshotDto): RuntimeTelemetrySnapshot {
  return {
    captureFps: normalizeFps(dto.captureFps),
    sendFps: normalizeFps(dto.sendFps),
    queueHealth: normalizeQueueHealth(dto.queueHealth),
  };
}

export async function getRuntimeTelemetrySnapshot(
  invoker: TelemetryInvoker = defaultInvoke,
): Promise<RuntimeTelemetrySnapshot> {
  const snapshot = await invoker<RuntimeTelemetrySnapshotDto>(DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY);
  return mapRuntimeTelemetrySnapshot(snapshot);
}
