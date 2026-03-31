import {
  HUE_RUNTIME_ACTION_HINT,
  type HueRuntimeActionHint,
  type HueRuntimeStatus,
} from "../../shared/contracts/hue";

export interface HueRuntimeStatusCardRetry {
  remainingAttempts?: number;
  nextAttemptMs?: number;
  labelKey: string;
}

export interface HueRuntimeStatusCardModel {
  variant: "success" | "error" | "info";
  titleKey: string;
  bodyKey: string;
  details?: string;
  actionHints: HueRuntimeActionHint[];
  retry?: HueRuntimeStatusCardRetry;
  triggerSourceKey?: string;
}

export interface HueRuntimeStatusCardInput {
  status: HueRuntimeStatus | null;
}

function resolveVariant(status: HueRuntimeStatus): HueRuntimeStatusCardModel["variant"] {
  if (status.state === "Running") {
    return "success";
  }

  if (status.state === "Failed") {
    return "error";
  }

  return "info";
}

export function deriveFamilyActionHints(code: string | null | undefined): HueRuntimeActionHint[] {
  if (typeof code !== "string" || code.length === 0) {
    return [];
  }

  // New HUE-* fault code families (take priority — more specific)
  if (code.startsWith("HUE-NET-")) {
    return [HUE_RUNTIME_ACTION_HINT.RECONNECT];
  }

  if (code.startsWith("HUE-AUTH-")) {
    return [HUE_RUNTIME_ACTION_HINT.REPAIR];
  }

  if (code.startsWith("HUE-STR-")) {
    return [HUE_RUNTIME_ACTION_HINT.RETRY, HUE_RUNTIME_ACTION_HINT.ADJUST_AREA];
  }

  if (code.startsWith("HUE-CFG-")) {
    return [HUE_RUNTIME_ACTION_HINT.REVALIDATE, HUE_RUNTIME_ACTION_HINT.ADJUST_AREA];
  }

  // Existing legacy families
  if (code.startsWith("AUTH_INVALID_")) {
    return [HUE_RUNTIME_ACTION_HINT.REPAIR];
  }

  if (code.startsWith("CONFIG_NOT_READY_")) {
    return [HUE_RUNTIME_ACTION_HINT.REVALIDATE, HUE_RUNTIME_ACTION_HINT.ADJUST_AREA];
  }

  if (code.startsWith("TRANSIENT_")) {
    return [HUE_RUNTIME_ACTION_HINT.RETRY, HUE_RUNTIME_ACTION_HINT.RECONNECT];
  }

  return [];
}

function resolveActionHints(status: HueRuntimeStatus): HueRuntimeActionHint[] {
  if (status.actionHint) {
    return [status.actionHint];
  }

  return deriveFamilyActionHints(status.code);
}

export function buildHueRuntimeStatusCard(input: HueRuntimeStatusCardInput): HueRuntimeStatusCardModel {
  if (!input.status) {
    return {
      variant: "info",
      titleKey: "device.hue.runtime.idleTitle",
      bodyKey: "device.hue.runtime.idleBody",
      actionHints: [],
    };
  }

  const status = input.status;
  const hasRetry = typeof status.remainingAttempts === "number" || typeof status.nextAttemptMs === "number";

  return {
    variant: resolveVariant(status),
    titleKey: `device.hue.runtime.states.${status.state}`,
    bodyKey: `device.hue.runtime.codes.${status.code}`,
    details: status.details ?? undefined,
    actionHints: resolveActionHints(status),
    retry: hasRetry
      ? {
          remainingAttempts: status.remainingAttempts,
          nextAttemptMs: status.nextAttemptMs,
          labelKey: "device.hue.runtime.retry.progress",
        }
      : undefined,
    triggerSourceKey: `device.hue.runtime.triggerSource.${status.triggerSource}`,
  };
}
