import type { HueRuntimeStatus, HueRuntimeTargetTelemetryRow } from "@/shared/contracts/hue";

export function deriveRuntimeTargets(status: HueRuntimeStatus | null): HueRuntimeTargetTelemetryRow[] {
  if (!status) {
    return [];
  }

  const hueTelemetry = status.telemetry?.hue;
  if (hueTelemetry) {
    return [
      {
        ...hueTelemetry,
        remainingAttempts: hueTelemetry.remainingAttempts ?? status.remainingAttempts,
        nextAttemptMs: hueTelemetry.nextAttemptMs ?? status.nextAttemptMs,
        actionHint: hueTelemetry.actionHint ?? status.actionHint,
      },
    ];
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
