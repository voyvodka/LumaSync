import type { HueRuntimeTargetTelemetryRow } from "@/shared/contracts/hue";

import type { HueRuntimeStatusView } from "./onboardingStatusCodes";

export function deriveRuntimeTargets(status: HueRuntimeStatusView | null): HueRuntimeTargetTelemetryRow[] {
  if (!status) {
    return [];
  }

  return [
    {
      target: "hue",
      state: status.state,
      code: status.code,
      message: status.message,
      details: status.details ?? undefined,
      remainingAttempts: status.remainingAttempts,
      nextAttemptMs: status.nextAttemptMs,
      actionHint: status.actionHint,
    },
  ];
}
