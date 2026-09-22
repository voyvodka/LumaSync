import { describeCaptureFailure, type CaptureFailureNotice } from "@/shared/contracts/capture";
import { LIGHTING_MODE_STATUS } from "@/shared/contracts/lighting";

import type { ModeCommandResult } from "../modeApi";
import type { LightingModeKind } from "../model/contracts";

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
