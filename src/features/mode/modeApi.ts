import { invoke } from "@tauri-apps/api/core";

import { DEVICE_COMMANDS } from "../../shared/contracts/device";
import {
  HUE_COMMANDS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeActionHint,
  type HueRuntimeState,
  type HueRuntimeTriggerSource,
} from "../../shared/contracts/hue";
import { normalizeLightingModeConfig, type LightingModeConfig } from "./model/contracts";

export interface ModeApiError {
  code: string;
  message: string;
  details?: string;
}

export interface ModeCommandResult {
  active: boolean;
  mode: LightingModeConfig;
  status: {
    code: string;
    message: string;
    details: string | null;
  };
}

export interface StartHuePayload {
  bridgeIp: string;
  username: string;
  clientKey: string;
  areaId: string;
  triggerSource?: HueRuntimeTriggerSource;
  /** Per-channel region overrides indexed by channel index. */
  channelRegionOverrides?: Record<number, string>;
}

export interface HueSolidColorPayload {
  r: number;
  g: number;
  b: number;
  brightness?: number;
  triggerSource?: HueRuntimeTriggerSource;
}

export interface HueSolidColorSnapshot {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export interface HueRuntimeCommandResult {
  active: boolean;
  status: {
    state: HueRuntimeState;
    code: string;
    message: string;
    details: string | null;
    triggerSource: HueRuntimeTriggerSource;
    remainingAttempts?: number;
    nextAttemptMs?: number;
    actionHint?: HueRuntimeActionHint;
  };
  lastSolidColor?: HueSolidColorSnapshot | null;
}

export type ModeInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: ModeInvoker = (command, payload) => invoke(command, payload);

function mapModeApiError(error: unknown): ModeApiError {
  if (!error || typeof error !== "object") {
    return {
      code: "UNKNOWN",
      message: "Lighting mode command failed",
    };
  }

  const data = error as Record<string, unknown>;
  const code = typeof data.code === "string" ? data.code : "UNKNOWN";
  const message = typeof data.message === "string" ? data.message : "Lighting mode command failed";
  const details = typeof data.details === "string" ? data.details : undefined;

  return {
    code,
    message,
    details,
  };
}

export async function setLightingMode(
  payload: LightingModeConfig,
  invoker: ModeInvoker = defaultInvoke,
): Promise<ModeCommandResult> {
  try {
    return await invoker<ModeCommandResult>(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: normalizeLightingModeConfig(payload),
    });
  } catch (error) {
    throw mapModeApiError(error);
  }
}

export async function stopLighting(invoker: ModeInvoker = defaultInvoke): Promise<ModeCommandResult> {
  try {
    return await invoker<ModeCommandResult>(DEVICE_COMMANDS.STOP_LIGHTING);
  } catch (error) {
    throw mapModeApiError(error);
  }
}

export async function getLightingModeStatus(invoker: ModeInvoker = defaultInvoke): Promise<ModeCommandResult> {
  try {
    return await invoker<ModeCommandResult>(DEVICE_COMMANDS.GET_LIGHTING_MODE_STATUS);
  } catch (error) {
    throw mapModeApiError(error);
  }
}

function overridesToList(overrides: Record<number, string>): (string | null)[] | undefined {
  const keys = Object.keys(overrides).map(Number);
  if (keys.length === 0) {
    return undefined;
  }
  const channelCount = Math.max(...keys) + 1;
  return Array.from({ length: channelCount }, (_, i) => overrides[i] ?? null);
}

export async function startHue(
  payload: StartHuePayload,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  try {
    const overrideList = payload.channelRegionOverrides
      ? overridesToList(payload.channelRegionOverrides)
      : undefined;
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.START_STREAM, {
      request: {
        bridgeIp: payload.bridgeIp,
        username: payload.username,
        clientKey: payload.clientKey,
        areaId: payload.areaId,
        triggerSource: payload.triggerSource ?? HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
        channelRegionOverrides: overrideList,
      },
    });
  } catch (error) {
    throw mapModeApiError(error);
  }
}

export async function stopHue(
  triggerSource: HueRuntimeTriggerSource = HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.STOP_STREAM, {
      triggerSource,
    });
  } catch (error) {
    throw mapModeApiError(error);
  }
}

export async function restartHue(
  payload: StartHuePayload,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  try {
    const overrideList = payload.channelRegionOverrides
      ? overridesToList(payload.channelRegionOverrides)
      : undefined;
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.RESTART_STREAM, {
      request: {
        bridgeIp: payload.bridgeIp,
        username: payload.username,
        clientKey: payload.clientKey,
        areaId: payload.areaId,
        triggerSource: payload.triggerSource ?? HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
        channelRegionOverrides: overrideList,
      },
    });
  } catch (error) {
    throw mapModeApiError(error);
  }
}

export async function getHueStreamStatus(invoker: ModeInvoker = defaultInvoke): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.GET_STREAM_STATUS);
  } catch (error) {
    throw mapModeApiError(error);
  }
}

export async function setHueSolidColor(
  payload: HueSolidColorPayload,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.SET_SOLID_COLOR, {
      request: {
        r: Math.max(0, Math.min(255, Math.floor(payload.r))),
        g: Math.max(0, Math.min(255, Math.floor(payload.g))),
        b: Math.max(0, Math.min(255, Math.floor(payload.b))),
        brightness: payload.brightness,
        triggerSource: payload.triggerSource ?? HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
      },
    });
  } catch (error) {
    throw mapModeApiError(error);
  }
}
