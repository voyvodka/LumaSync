import { DEVICE_ERROR_CODES, type DeviceErrorCode } from "@/shared/contracts/device";
import {
  HUE_COMMANDS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueChannelPlacementOverride,
  type HueRuntimeCommandResult,
  type HueRuntimeTarget,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";
import {
  LIGHTING_ORIGIN,
  LIGHTING_RUNTIME_COMMANDS,
  type ApplyOutputsRequest,
  type ApplyOutputsResult,
  type LightingRuntimeSnapshot,
  type LightingTuning,
  type ReleaseHueTrigger,
  type RetuneLightingResult,
} from "@/shared/contracts/lightingRuntime";
import { parseCommandError } from "@/shared/contracts/status";
import { normalizeAmbilightPayload, normalizeSolidColorPayload } from "@/shared/contracts/mode";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

export type { HueRuntimeCommandResult, HueSolidColorSnapshot } from "@/shared/contracts/hue";
export type { LightingModeCommandResult } from "@/shared/contracts/mode";

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

/** Start the Hue entertainment stream for the given bridge/area. Throws a `ModeApiError` on failure. */
export async function startHue(
  payload: StartHuePayload,
  invoker: CommandInvoker = invokeCommand,
): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker(HUE_COMMANDS.START_STREAM, {
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
  }
}

/** Stop and re-start the Hue stream in one call — used to pick up new area/credential/channel settings. */
export async function restartHue(
  payload: StartHuePayload,
  invoker: CommandInvoker = invokeCommand,
): Promise<HueRuntimeCommandResult> {
  try {
    return await invoker(HUE_COMMANDS.RESTART_STREAM, {
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
  }
}

// ---------------------------------------------------------------------------
// The Rust lighting transaction (docs/architecture/lighting-transaction.md).
// ---------------------------------------------------------------------------

/** Reconcile the running mode and outputs toward the request; the reply's
 * `snapshot` is what runs afterwards. Coded refusals ride `status`. */
export async function applyOutputs(
  request: ApplyOutputsRequest,
  invoker: CommandInvoker = invokeCommand,
): Promise<ApplyOutputsResult> {
  // The kind and whichever payload the caller has, normalised. A payload left
  // out keeps the last one in Rust, so it must not be filled with a default here.
  const mode = request.mode
    ? {
        kind: request.mode.kind,
        ...(request.mode.solid ? { solid: normalizeSolidColorPayload(request.mode.solid) } : {}),
        ...(request.mode.ambilight ? { ambilight: normalizeAmbilightPayload(request.mode.ambilight) } : {}),
      }
    : request.mode;
  try {
    return await invoker(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, {
      request: { ...request, mode },
    });
  } catch (error) {
    throw mapModeApiError(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, error);
  }
}

/** A brightness or colour nudge within the running kind; never waits for a transition. */
export async function retuneLighting(
  tuning: LightingTuning,
  invoker: CommandInvoker = invokeCommand,
): Promise<RetuneLightingResult> {
  try {
    return await invoker(LIGHTING_RUNTIME_COMMANDS.RETUNE_LIGHTING, {
      tuning,
    });
  } catch (error) {
    throw mapModeApiError(LIGHTING_RUNTIME_COMMANDS.RETUNE_LIGHTING, error);
  }
}

/** Take Hue out of the running mode and stop its stream, attributed to `triggerSource`. */
export async function releaseHueOutput(
  triggerSource: ReleaseHueTrigger,
  invoker: CommandInvoker = invokeCommand,
): Promise<ApplyOutputsResult> {
  try {
    return await invoker(LIGHTING_RUNTIME_COMMANDS.RELEASE_HUE_OUTPUT, {
      triggerSource,
    });
  } catch (error) {
    throw mapModeApiError(LIGHTING_RUNTIME_COMMANDS.RELEASE_HUE_OUTPUT, error);
  }
}

/** The last published runtime snapshot; answers at once, even mid-transition. */
export async function getLightingRuntime(
  invoker: CommandInvoker = invokeCommand,
): Promise<LightingRuntimeSnapshot> {
  try {
    return await invoker(LIGHTING_RUNTIME_COMMANDS.GET_LIGHTING_RUNTIME);
  } catch (error) {
    throw mapModeApiError(LIGHTING_RUNTIME_COMMANDS.GET_LIGHTING_RUNTIME, error);
  }
}

/**
 * Bring the Hue stream up for a test pattern that targets it. Rust owns the
 * lease: it opens the stream only when nothing else has, and remembers that it
 * did. A test that does not target Hue asks nothing.
 */
export async function acquireHueForTest(
  targets: readonly HueRuntimeTarget[] | undefined,
  invoker: CommandInvoker = invokeCommand,
): Promise<void> {
  if (!targets?.includes("hue")) return;
  try {
    await applyOutputs({ targets: ["hue"], origin: LIGHTING_ORIGIN.LEASE_HUE }, invoker);
  } catch (error) {
    console.error("[LumaSync] Hue test lease could not start the stream:", error);
  }
}

/**
 * Hand the stream back after a test. Rust stops it only if the lease opened it
 * and no mode started meanwhile has adopted it; safe to call unconditionally.
 */
export async function releaseHueAfterTest(invoker: CommandInvoker = invokeCommand): Promise<void> {
  try {
    await applyOutputs({ targets: [], origin: LIGHTING_ORIGIN.LEASE_HUE }, invoker);
  } catch (error) {
    console.error("[LumaSync] Hue test lease could not hand the stream back:", error);
  }
}
