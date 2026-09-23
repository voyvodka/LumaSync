import type { TranslationKey } from "@/features/i18n/catalogue";
import { HUE_STATUS, type HueCredentialStatus } from "@/shared/contracts/hue";
import type { HueOnboardingStatus, HueRuntimeStatusView } from "./onboardingStatusCodes";

const PAIRING_ERROR_DESCRIPTIONS: Partial<Record<string, TranslationKey>> = {
  [HUE_STATUS.PAIRING_DEVICETYPE_INVALID]: "hue:pairing.errors.DEVICETYPE_INVALID.description",
  [HUE_STATUS.PAIRING_BRIDGE_BUSY]: "hue:pairing.errors.BRIDGE_BUSY.description",
  [HUE_STATUS.PAIRING_RATE_LIMITED]: "hue:pairing.errors.RATE_LIMITED.description",
};

/** The specific explanation for a pairing refusal the bridge named, if any. */
export function huePairingErrorDescriptionKey(code: string | null | undefined): TranslationKey | null {
  if (!code || !Object.prototype.hasOwnProperty.call(PAIRING_ERROR_DESCRIPTIONS, code)) return null;
  return PAIRING_ERROR_DESCRIPTIONS[code] ?? null;
}

export type HueBridgeCardState =
  | "stopPartial"
  | "gateBlocked"
  | "streaming"
  | "reconnecting"
  | "offline"
  | "pairingLinkButton"
  | "pairingTimedOut"
  | "pairingDeferred"
  | "pairingFailed"
  | "authError"
  | "pairing"
  | "areaSelect"
  | "statusUnknown"
  | "stale"
  | "idle";

export interface HueBridgeCardStateInput {
  selectedBridgeId: string | null;
  runtimeStatus: HueRuntimeStatusView | null;
  /** The latest runtime-status read rejected, so `runtimeStatus` is stale. */
  runtimeStatusUnavailable: boolean;
  hueStatus: HueOnboardingStatus | null;
  credentialState: HueCredentialStatus;
  bridgeUnreachable: boolean;
  isPairing: boolean;
  selectedAreaId: string | null;
  isReadinessStale: boolean;
}

export function deriveHueBridgeCardState({
  selectedBridgeId,
  runtimeStatus: lastRuntimeStatus,
  runtimeStatusUnavailable,
  hueStatus,
  credentialState,
  bridgeUnreachable,
  isPairing,
  selectedAreaId,
  isReadinessStale,
}: HueBridgeCardStateInput): HueBridgeCardState | null {
  if (!selectedBridgeId) return null;

  // A rejected status read says nothing about the runtime: neither the last
  // status nor "Ready" may speak for it until a read lands again.
  const runtimeStatus = runtimeStatusUnavailable ? null : lastRuntimeStatus;
  if (runtimeStatus?.code === "HUE_STOP_TIMEOUT_PARTIAL") return "stopPartial";
  if (runtimeStatus?.code === "CONFIG_NOT_READY_GATE_BLOCKED") return "gateBlocked";
  if (runtimeStatus?.state === "Running") return "streaming";
  if (runtimeStatus?.state === "Reconnecting" || runtimeStatus?.code?.startsWith("TRANSIENT_")) return "reconnecting";
  if (bridgeUnreachable) return "offline";
  if (credentialState === "needs_repair" && !isPairing) {
    // A rejected link button is a pairing step the user can still complete —
    // never surface it as "credentials expired" (#167). Outside a pairing run
    // it only survives once the polling window has run out (#337).
    if (hueStatus?.code === "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED") return "pairingTimedOut";
    // Busy and rate-limited are the bridge asking us to wait, not a rejected
    // credential — same rule as the link button above.
    if (hueStatus?.code === "HUE_PAIRING_BRIDGE_BUSY" || hueStatus?.code === "HUE_PAIRING_RATE_LIMITED") {
      return "pairingDeferred";
    }
    return hueStatus?.code === "HUE_PAIRING_FAILED" || hueStatus?.code === "HUE_PAIRING_DEVICETYPE_INVALID"
      ? "pairingFailed"
      : "authError";
  }
  if (isPairing) {
    // Minted by useHueOnboardingCore between polls; Rust never sends it.
    return hueStatus?.code === "HUE_PAIRING_PENDING_LINK_BUTTON" ? "pairingLinkButton" : "pairing";
  }
  if (credentialState === "valid") {
    if (!selectedAreaId) return "areaSelect";
    if (runtimeStatusUnavailable) return "statusUnknown";
    if (isReadinessStale) return "stale";
    return "idle";
  }
  return "pairing";
}
