import { invoke } from "@tauri-apps/api/core";

import { DEVICE_COMMANDS } from "../../shared/contracts/device";
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
