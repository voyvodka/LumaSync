import { invoke } from "@tauri-apps/api/core";

import { DEVICE_COMMANDS } from "../../shared/contracts/device";
import {
  TELEMETRY_QUEUE_HEALTH,
  type FullTelemetrySnapshot,
  type HueTelemetrySnapshot,
  type RuntimeTelemetrySnapshot,
} from "./model/contracts";

interface RuntimeTelemetrySnapshotDto {
  captureFps: number;
  sendFps: number;
  queueHealth: string;
}

interface HueTelemetrySnapshotDto {
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

interface FullTelemetrySnapshotDto {
  usb: RuntimeTelemetrySnapshotDto;
  hue: HueTelemetrySnapshotDto | null;
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

function mapHueTelemetrySnapshot(dto: HueTelemetrySnapshotDto): HueTelemetrySnapshot {
  return {
    state: dto.state,
    uptimeSecs: dto.uptimeSecs,
    packetRate: typeof dto.packetRate === "number" ? Math.max(0, dto.packetRate) : 0,
    lastErrorCode: dto.lastErrorCode,
    lastErrorAtSecs: dto.lastErrorAtSecs,
    totalReconnects: dto.totalReconnects ?? 0,
    successfulReconnects: dto.successfulReconnects ?? 0,
    failedReconnects: dto.failedReconnects ?? 0,
    dtlsActive: dto.dtlsActive ?? false,
    dtlsCipher: dto.dtlsCipher,
    dtlsConnectedAtSecs: dto.dtlsConnectedAtSecs,
  };
}

export function mapFullTelemetrySnapshot(dto: FullTelemetrySnapshotDto): FullTelemetrySnapshot {
  return {
    usb: mapRuntimeTelemetrySnapshot(dto.usb),
    hue: dto.hue ? mapHueTelemetrySnapshot(dto.hue) : null,
  };
}

export async function getFullTelemetrySnapshot(
  invoker: TelemetryInvoker = defaultInvoke,
): Promise<FullTelemetrySnapshot> {
  const snapshot = await invoker<FullTelemetrySnapshotDto>(DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY);
  return mapFullTelemetrySnapshot(snapshot);
}

/**
 * @deprecated Use getFullTelemetrySnapshot instead which includes Hue telemetry.
 */
export async function getRuntimeTelemetrySnapshot(
  invoker: TelemetryInvoker = defaultInvoke,
): Promise<RuntimeTelemetrySnapshot> {
  const snapshot = await invoker<FullTelemetrySnapshotDto>(DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY);
  return mapRuntimeTelemetrySnapshot(snapshot.usb);
}
