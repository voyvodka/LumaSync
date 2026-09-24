import {
  AMBILIGHT_CAPTURE_REASON,
  CAPTURE_FAILURE_BUCKET,
  describeCaptureFailure,
  type CaptureFailureNotice,
} from "@/shared/contracts/capture";
import { LIGHTING_MODE_GATE_STATUS, LIGHTING_MODE_STATUS } from "@/shared/contracts/lighting";
import {
  LIGHTING_OUTPUTS_STATUS,
  type ApplyOutputsResult,
} from "@/shared/contracts/lightingRuntime";

/**
 * The notice a transaction's reply calls for, or `null`. A capture start that
 * failed names its reason in the apply status's `details`; a strip the device
 * gate kept out of a running mode borrows the output bucket's copy; a failed
 * Solid start is named only for an output reason, because every other
 * bucket's copy is about screen capture.
 */
export function startFailureNotice(result: ApplyOutputsResult): CaptureFailureNotice | null {
  const apply = result.outcome.applyStatus;
  if (apply === null) return null;
  switch (apply.code) {
    case LIGHTING_MODE_STATUS.AMBILIGHT_MODE_START_FAILED:
      return describeCaptureFailure(apply.details);
    case LIGHTING_MODE_STATUS.SOLID_MODE_APPLY_FAILED: {
      const notice = describeCaptureFailure(apply.details);
      return notice.bucket === CAPTURE_FAILURE_BUCKET.OUTPUT ? notice : null;
    }
    case LIGHTING_MODE_GATE_STATUS.DEVICE_NOT_CONNECTED:
      return result.outcome.droppedTargets.includes("usb")
        ? describeCaptureFailure(AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_DEVICE_NOT_CONNECTED)
        : null;
    default:
      return null;
  }
}

/**
 * The strip needs LED Setup before this choice can run: no calibration at all,
 * or a saved one whose counts Rust refused (`config_check.rs` prefixes its
 * reason with the field). Either way the editor is where it gets fixed.
 */
export function needsCalibration(result: ApplyOutputsResult): boolean {
  if (result.status.code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_CALIBRATION_REQUIRED) return true;
  const apply = result.outcome.applyStatus;
  return (
    apply?.code === LIGHTING_MODE_STATUS.LIGHTING_MODE_INVALID_CONFIG &&
    (apply.details ?? "").startsWith("ledCalibration")
  );
}

/** The mode asked for runs, on some of its outputs at least. */
export function isOutputsApplied(result: ApplyOutputsResult): boolean {
  return (
    result.status.code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_APPLIED ||
    result.status.code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_APPLIED_PARTIAL
  );
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
