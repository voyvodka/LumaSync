import type { HueRuntimeStatus, HueRuntimeTargetTelemetryRow } from "@/shared/contracts/hue";

export function deriveRuntimeTargets(status: HueRuntimeStatus | null): HueRuntimeTargetTelemetryRow[] {
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
