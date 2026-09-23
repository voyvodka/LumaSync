import { invoke } from "@tauri-apps/api/core";

import {
  DEVICE_COMMANDS,
  DEVICE_ERROR_CODES,
  type DeviceErrorCode,
  type WledLiveFrameAdvisory,
} from "@/shared/contracts/device";
import {
  HUE_COMMANDS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueChannelPlacementOverride,
  type HueRuntimeStatus,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";
import type { LightingModeStatusCode } from "@/shared/contracts/lighting";
import { parseCommandError, type CommandStatusOf } from "@/shared/contracts/status";
// Cyclic with hueReadCache (it wraps `getHueStreamStatus` below); safe because
// neither side calls across the cycle at module-eval time.
import { invalidateHueStreamStatus } from "../hue/hueReadCache";
import { normalizeLightingModeConfig, type LightingModeConfig } from "./model/contracts";
import { cancelBootHueRetry } from "./state/bootHueRetry";

/** Normalized shape every mode-command rejection is mapped to before being thrown. */
export interface ModeApiError {
  code: DeviceErrorCode;
  message: string;
  details?: string;
}

function isDeviceErrorCode(value: unknown): value is DeviceErrorCode {
  return (
    typeof value === "string" &&
    (Object.values(DEVICE_ERROR_CODES) as string[]).includes(value)
  );
}

export interface ModeCommandResult {
  active: boolean;
  mode: LightingModeConfig;
  status: CommandStatusOf<LightingModeStatusCode>;
  /** Non-fatal: the stream started but part of the WLED strip will not track.
   * Rides alongside a success status rather than replacing it. */
  wledAdvisory?: WledLiveFrameAdvisory | null;
}

/** Bridge/credential/area selection needed to start (or restart) the Hue entertainment stream. */
export interface StartHuePayload {
  bridgeIp: string;
  username: string;
  clientKey: string;
  areaId: string;
  triggerSource?: HueRuntimeTriggerSource;
  /** The user's own placements for the area, addressed by the bridge's channel id. */
  channelPlacements?: HueChannelPlacementOverride[];
}

export interface HueSolidColorPayload {
  r: number;
  g: number;
  b: number;
  brightness?: number;
  triggerSource?: HueRuntimeTriggerSource;
}

/** Last solid color successfully (or pending) applied to the Hue lights. */
export interface HueSolidColorSnapshot {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export interface HueRuntimeCommandResult {
  active: boolean;
  status: HueRuntimeStatus;
  lastSolidColor?: HueSolidColorSnapshot | null;
}

/** Injectable `invoke()` signature so mode commands can be unit-tested with a mock transport. */
export type ModeInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: ModeInvoker = (command, payload) => invoke(command, payload);

function mapModeApiError(command: string, error: unknown): ModeApiError {
  const parsed = parseCommandError(error);
  // The code is usually a lighting/Hue one outside `DeviceErrorCode`, so it
  // collapses to UNKNOWN here — the raw text in the log is what keeps it.
  console.error(`[LumaSync] ${command} rejected:`, parsed.message);
  return {
    // Relayed only when it names a declared code.
    code: isDeviceErrorCode(parsed.code) ? parsed.code : DEVICE_ERROR_CODES.UNKNOWN,
    message: parsed.message,
    details: parsed.details ?? undefined,
  };
}

/** Apply a USB lighting mode (Off/Ambilight/Solid) to the connected device. Throws a `ModeApiError` on failure. */
export async function setLightingMode(
  payload: LightingModeConfig,
  invoker: ModeInvoker = defaultInvoke,
): Promise<ModeCommandResult> {
  // `normalizeLightingModeConfig` drops `roomGeometry` so a persisted mode can
  // never carry it, and unlike the output stamps Rust does not hydrate it — so
  // it is re-attached here, or no dispatch would ever reach room-aware sampling.
  const normalized = normalizeLightingModeConfig(payload);
  const wire = payload.roomGeometry
    ? { ...normalized, roomGeometry: payload.roomGeometry }
    : normalized;
  try {
    return await invoker<ModeCommandResult>(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: wire,
    });
  } catch (error) {
    throw mapModeApiError(DEVICE_COMMANDS.SET_LIGHTING_MODE, error);
  }
}

/** Turn off USB lighting output, superseding any active test pattern. Throws a `ModeApiError` on failure. */
export async function stopLighting(invoker: ModeInvoker = defaultInvoke): Promise<ModeCommandResult> {
  try {
    return await invoker<ModeCommandResult>(DEVICE_COMMANDS.STOP_LIGHTING);
  } catch (error) {
    throw mapModeApiError(DEVICE_COMMANDS.STOP_LIGHTING, error);
  }
}

/** Read the currently active USB lighting mode without changing it. */
export async function getLightingModeStatus(invoker: ModeInvoker = defaultInvoke): Promise<ModeCommandResult> {
  try {
    return await invoker<ModeCommandResult>(DEVICE_COMMANDS.GET_LIGHTING_MODE_STATUS);
  } catch (error) {
    throw mapModeApiError(DEVICE_COMMANDS.GET_LIGHTING_MODE_STATUS, error);
  }
}

/** Start the Hue entertainment stream for the given bridge/area. Throws a `ModeApiError` on failure. */
export async function startHue(
  payload: StartHuePayload,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.START_STREAM, {
      request: {
        bridgeIp: payload.bridgeIp,
        username: payload.username,
        clientKey: payload.clientKey,
        areaId: payload.areaId,
        triggerSource: payload.triggerSource ?? HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
        channelPlacements: payload.channelPlacements,
      },
    });
  } catch (error) {
    throw mapModeApiError(HUE_COMMANDS.START_STREAM, error);
  } finally {
    // Attached to the command, not to a call site: a stale status lets the App
    // health reconciler act on a pre-mutation answer and undo what just happened.
    invalidateHueStreamStatus();
  }
}

/** Stop the active Hue entertainment stream. Throws a `ModeApiError` on failure. */
export async function stopHue(
  triggerSource: HueRuntimeTriggerSource = HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  // Attached to the command, as `stop_hue_stream` cancels the backend's
  // reconnect: a stop from any surface also ends a pending boot retry.
  cancelBootHueRetry("Hue was stopped");
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.STOP_STREAM, {
      triggerSource,
    });
  } catch (error) {
    throw mapModeApiError(HUE_COMMANDS.STOP_STREAM, error);
  } finally {
    invalidateHueStreamStatus();
  }
}

/** Stop and re-start the Hue stream in one call — used to pick up new area/credential/channel settings. */
export async function restartHue(
  payload: StartHuePayload,
  invoker: ModeInvoker = defaultInvoke,
): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.RESTART_STREAM, {
      request: {
        bridgeIp: payload.bridgeIp,
        username: payload.username,
        clientKey: payload.clientKey,
        areaId: payload.areaId,
        triggerSource: payload.triggerSource ?? HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
        channelPlacements: payload.channelPlacements,
      },
    });
  } catch (error) {
    throw mapModeApiError(HUE_COMMANDS.RESTART_STREAM, error);
  } finally {
    invalidateHueStreamStatus();
  }
}

/** Poll the Hue stream's current runtime state; self-heals if the background sender thread has died. */
export async function getHueStreamStatus(invoker: ModeInvoker = defaultInvoke): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker<HueRuntimeCommandResult>(HUE_COMMANDS.GET_STREAM_STATUS);
  } catch (error) {
    throw mapModeApiError(HUE_COMMANDS.GET_STREAM_STATUS, error);
  }
}

/** Push a static RGB color to the Hue lights; queued for replay if the stream isn't running yet. */
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
    throw mapModeApiError(HUE_COMMANDS.SET_SOLID_COLOR, error);
  }
}
