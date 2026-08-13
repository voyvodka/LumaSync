import { HUE_RUNTIME_ACTION_HINT, type HueRuntimeActionHint } from "@/shared/contracts/hue";
import type { TranslationKey } from "@/features/i18n/catalogue";

import type { HueRuntimeStatusView } from "./onboardingStatusCodes";

export interface HueRuntimeStatusCardRetry {
  remainingAttempts?: number;
  nextAttemptMs?: number;
  labelKey: TranslationKey;
}

export interface HueRuntimeStatusCardModel {
  variant: "success" | "error" | "info";
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  details?: string;
  actionHints: HueRuntimeActionHint[];
  retry?: HueRuntimeStatusCardRetry;
  triggerSourceKey?: TranslationKey;
}

export interface HueRuntimeStatusCardInput {
  status: HueRuntimeStatusView | null;
}

function resolveVariant(status: HueRuntimeStatusView): HueRuntimeStatusCardModel["variant"] {
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

  // Specific code matches (take priority over family prefixes).
  // `HUE_STOP_TIMEOUT_PARTIAL` surfaces when a stop request times out mid-flight;
  // the natural recovery is to invoke `stop_lighting` again — same path as the
  // DeviceSection inline "Retry Stop" CTA (see B-08, A3.2).
  if (code === "HUE_STOP_TIMEOUT_PARTIAL") {
    return [HUE_RUNTIME_ACTION_HINT.RETRY];
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

function resolveActionHints(status: HueRuntimeStatusView): HueRuntimeActionHint[] {
  if (status.actionHint) {
    return [status.actionHint];
  }

  return deriveFamilyActionHints(status.code);
}

export function buildHueRuntimeStatusCard(input: HueRuntimeStatusCardInput): HueRuntimeStatusCardModel {
  if (!input.status) {
    return {
      variant: "info",
      titleKey: "hue:runtime.idleTitle",
      bodyKey: "hue:runtime.idleBody",
      actionHints: [],
    };
  }

  const status = input.status;
  // The wire sends `null`, not an absent key. Project it to `undefined` here so
  // the flag and the values it guards can never disagree.
  const remainingAttempts =
    typeof status.remainingAttempts === "number" ? status.remainingAttempts : undefined;
  const nextAttemptMs = typeof status.nextAttemptMs === "number" ? status.nextAttemptMs : undefined;
  const hasRetry = remainingAttempts !== undefined || nextAttemptMs !== undefined;

  return {
    variant: resolveVariant(status),
    titleKey: `hue:runtime.states.${status.state}`,
    // `status.code` is `HueRuntimeStatusCode | string` — HUE-* fault-family codes (see
    // deriveFamilyActionHints) are open strings by design, not enum members.
    bodyKey: `hue:runtime.codes.${status.code}` as TranslationKey,
    details: status.details ?? undefined,
    actionHints: resolveActionHints(status),
    retry: hasRetry
      ? {
          remainingAttempts,
          nextAttemptMs,
          labelKey: "hue:runtime.retry.progress",
        }
      : undefined,
    triggerSourceKey: `hue:runtime.triggerSource.${status.triggerSource}`,
  };
}
