import type { HueCredentialStatus, HueRuntimeStatus } from "@/shared/contracts/hue";
import type { CommandStatus } from "../hueOnboardingApi";

export type HueBridgeCardState =
  | "stopPartial"
  | "gateBlocked"
  | "streaming"
  | "reconnecting"
  | "offline"
  | "pairingLinkButton"
  | "pairingFailed"
  | "authError"
  | "pairing"
  | "areaSelect"
  | "stale"
  | "idle";

export interface HueBridgeCardStateInput {
  selectedBridgeId: string | null;
  runtimeStatus: HueRuntimeStatus | null;
  hueStatus: CommandStatus | null;
  credentialState: HueCredentialStatus;
  bridgeUnreachable: boolean;
  isPairing: boolean;
  selectedAreaId: string | null;
  isReadinessStale: boolean;
}

export function deriveHueBridgeCardState({
  selectedBridgeId,
  runtimeStatus,
  hueStatus,
  credentialState,
  bridgeUnreachable,
  isPairing,
  selectedAreaId,
  isReadinessStale,
}: HueBridgeCardStateInput): HueBridgeCardState | null {
  if (!selectedBridgeId) return null;

  if (runtimeStatus?.code === "HUE_STOP_TIMEOUT_PARTIAL") return "stopPartial";
  if (runtimeStatus?.code === "CONFIG_NOT_READY_GATE_BLOCKED") return "gateBlocked";
  if (runtimeStatus?.state === "Running") return "streaming";
  if (runtimeStatus?.state === "Reconnecting" || runtimeStatus?.code?.startsWith("TRANSIENT_")) return "reconnecting";
  if (bridgeUnreachable) return "offline";
  if (credentialState === "needs_repair" && !isPairing) {
    // A rejected link button is a pairing step the user can still complete —
    // never surface it as "credentials expired" (#167).
    if (hueStatus?.code === "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED") return "pairingLinkButton";
    return hueStatus?.code === "HUE_PAIRING_FAILED" ? "pairingFailed" : "authError";
  }
  if (isPairing) {
    return hueStatus?.code === "HUE_PAIRING_PENDING_LINK_BUTTON" ? "pairingLinkButton" : "pairing";
  }
  if (credentialState === "valid") {
    if (!selectedAreaId) return "areaSelect";
    if (isReadinessStale) return "stale";
    return "idle";
  }
  return "pairing";
}
