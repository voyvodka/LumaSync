import type {
  ApplyOutputsOutcome,
  ApplyOutputsResult,
  LightingOutputsStatusCode,
  LightingRuntimeSnapshot,
} from "@/shared/contracts/lightingRuntime";

/** A whole `LightingRuntimeSnapshot`, idle on USB unless overridden. */
export function runtimeSnapshot(overrides: Partial<LightingRuntimeSnapshot> = {}): LightingRuntimeSnapshot {
  return {
    revision: 1,
    mode: { kind: "off" },
    active: false,
    activeTargets: [],
    selectedTargets: ["usb"],
    phase: "idle",
    requestId: null,
    hueHeldOutReason: null,
    bootHueRetry: null,
    ...overrides,
  };
}

/** A whole `apply_outputs` answer. */
export function outputsResult(
  code: LightingOutputsStatusCode = "OUTPUTS_APPLIED",
  snapshot: LightingRuntimeSnapshot = runtimeSnapshot(),
  outcome: Partial<ApplyOutputsOutcome> = {},
): ApplyOutputsResult {
  return {
    status: { code, message: "", details: null },
    requestId: 1,
    snapshot,
    outcome: {
      hueStartCode: null,
      hueLeftOut: null,
      applyStatus: null,
      stopFailed: [],
      droppedTargets: [],
      modeEnded: false,
      ...outcome,
    },
  };
}
