import {
  CAPTURE_FAILURE_BUCKET,
  describeCaptureFailure,
  type CaptureFailureNotice,
} from "@/shared/contracts/capture";
import { isHueStartCodeOk } from "@/features/hue/model/hueStartConfig";
import { deriveFamilyActionHints } from "@/features/hue/model/hueRuntimeStatusCard";
import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_STATUS,
  type HueRuntimeTarget,
} from "@/shared/contracts/hue";
import {
  HUE_LEFT_OUT_REASON,
  LIGHTING_MODE_GATE_STATUS,
  LIGHTING_MODE_STATUS,
  type HueLeftOutReason,
} from "@/shared/contracts/lighting";

import type { ModeCommandResult } from "../modeApi";
import { LIGHTING_MODE_KIND, type LightingModeConfig, type LightingModeKind } from "../model/contracts";

export interface ModeApplyOutcome {
  /** The backend is not running the requested mode. */
  refused: boolean;
  /** Set when the capture start failed; the reason the user can act on. */
  startFailure: CaptureFailureNotice | null;
}

/**
 * How a `set_lighting_mode` reply is read. Shared by the interactive slow path
 * and the boot restore so the two cannot disagree about what "it ran" means.
 */
export function readModeApplyOutcome(
  result: ModeCommandResult | null,
  requestedKind: LightingModeKind,
): ModeApplyOutcome {
  // `null` is a deduped dispatch — the backend was never asked, so nothing was refused.
  if (result === null) return { refused: false, startFailure: null };
  return {
    // `mode` reports the RUNNING mode, so a gate refusal while another
    // kind is live reads as refused too — `active` alone would not.
    refused: result.mode.kind !== requestedKind,
    // A failed capture start resolves as `Ok` carrying a status, not a throw.
    // The reason is free text in `details`; `describeCaptureFailure` is the
    // only thing that reads it.
    startFailure:
      result.status.code === LIGHTING_MODE_STATUS.AMBILIGHT_MODE_START_FAILED
        ? describeCaptureFailure(result.status.details)
        : null,
  };
}

/**
 * The start notice to show when the permission probe already raised one. The
 * backend's reason wins when it names a cause; an unclassified one would
 * replace an actionable "check screen recording" with a generic failure.
 */
export function pickStartFailureNotice(
  probeNotice: CaptureFailureNotice | null,
  backendNotice: CaptureFailureNotice,
): CaptureFailureNotice {
  if (probeNotice !== null && backendNotice.bucket === CAPTURE_FAILURE_BUCKET.INTERNAL) {
    return probeNotice;
  }
  return backendNotice;
}

export interface HueReleaseInput {
  /** `start_hue_stream` accepted this apply's start. */
  hueStartedOk: boolean;
  /** The code that start returned. */
  hueStartCode: string | undefined;
  /** "hue" was in the active targets before this apply. */
  hueActiveBefore: boolean;
  /** What the backend reports running after the refusal. */
  runningMode: Pick<LightingModeConfig, "kind" | "targets">;
}

/**
 * Whether a refused apply must give back the Hue stream. The bridge admits one
 * entertainment streamer, so a stream no running mode feeds locks out every
 * other client while sending nothing. Only a stream this session owns is
 * released: one this apply opened, or the previous mode's once the backend has
 * torn that mode down. A no-op start on a stream the session did not hold
 * belongs to someone else (a test lease) and is left alone.
 */
export function shouldReleaseHueAfterRefusal({
  hueStartedOk,
  hueStartCode,
  hueActiveBefore,
  runningMode,
}: HueReleaseInput): boolean {
  if (!hueStartedOk) return false;
  const openedHere = hueStartCode !== HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE;
  if (!openedHere && !hueActiveBefore) return false;
  const runningUsesHue =
    runningMode.kind !== LIGHTING_MODE_KIND.OFF && (runningMode.targets ?? []).includes("hue");
  return !runningUsesHue;
}

/**
 * The targets to re-dispatch with when the Hue gate refused a `[usb, hue]`
 * start, or `null` for any other reply. The gate returns before the previous
 * mode is touched, so a USB-only retry is a clean second attempt. Shared by the
 * interactive slow path and the boot restore so the two cannot disagree. The
 * drop is session-only: callers must never write it to `lastOutputTargets`.
 */
export function hueLeftOutRetryTargets(
  result: ModeCommandResult | null,
  requestedTargets: readonly HueRuntimeTarget[],
): HueRuntimeTarget[] | null {
  if (result === null || result.status.code !== LIGHTING_MODE_GATE_STATUS.HUE_NOT_READY) return null;
  if (!requestedTargets.includes("usb") || !requestedTargets.includes("hue")) return null;
  const remaining = requestedTargets.filter((target) => target !== "hue");
  return remaining.includes("usb") ? remaining : null;
}

/**
 * Which notice a left-out Hue gets. With a start config in hand, Rust's
 * `CONFIG_NOT_READY_GATE_BLOCKED` means its readiness probe failed — the bridge
 * did not answer, or the area would not stream — so it reads as unreachable.
 * Only a missing config is "not set up".
 */
export function hueLeftOutReason(
  hadStartConfig: boolean,
  hueStartCode: string | undefined,
): HueLeftOutReason {
  if (!hadStartConfig) return HUE_LEFT_OUT_REASON.CONFIG;
  if (
    hueStartCode !== undefined &&
    deriveFamilyActionHints(hueStartCode).includes(HUE_RUNTIME_ACTION_HINT.REPAIR)
  ) {
    return HUE_LEFT_OUT_REASON.AUTH;
  }
  return HUE_LEFT_OUT_REASON.UNREACHABLE;
}

export interface HueCancelInput {
  hueStartCode: string | undefined;
  /** "hue" was in the active targets before this apply; always true at boot. */
  hueActiveBefore: boolean;
}

/**
 * Whether leaving Hue out must also stop it. A start that left the runtime
 * non-idle keeps retrying (`hue/reconnect.rs`), and the stream health poll then
 * re-adds "hue" behind the notice's back; `stop_hue_stream` is what cancels
 * that retry. A no-op start on a stream the session did not hold belongs to
 * someone else (a test lease) and is left alone, as in
 * `shouldReleaseHueAfterRefusal`.
 */
export function shouldCancelHueAfterLeavingOut({
  hueStartCode,
  hueActiveBefore,
}: HueCancelInput): boolean {
  if (hueStartCode === undefined) return false;
  if (hueStartCode === HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED) return true;
  if (!isHueStartCodeOk(hueStartCode)) return false;
  return hueStartCode !== HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE || hueActiveBefore;
}
