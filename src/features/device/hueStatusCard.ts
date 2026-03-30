import type { HueCredentialStatus } from "../../shared/contracts/hue";
import type { CommandStatus } from "./hueOnboardingApi";

export interface HueStatusCardModel {
  variant: "success" | "error" | "info";
  titleKey: string;
  bodyKey: string;
  details?: string;
}

export interface HueStatusCardInput {
  status: CommandStatus | null;
  credentialState: HueCredentialStatus;
  isValidatingCredential: boolean;
  isPairing: boolean;
  isCheckingReadiness: boolean;
  bridgeUnreachable?: boolean;
}

export function buildHueStatusCard(input: HueStatusCardInput): HueStatusCardModel {
  if (input.isValidatingCredential) {
    return {
      variant: "info",
      titleKey: "device.hue.status.validatingTitle",
      bodyKey: "device.hue.status.validatingBody",
    };
  }

  if (input.isPairing) {
    return {
      variant: "info",
      titleKey: "device.hue.status.pairingTitle",
      bodyKey: "device.hue.status.pairingBody",
    };
  }

  if (input.isCheckingReadiness) {
    return {
      variant: "info",
      titleKey: "device.hue.status.readinessCheckingTitle",
      bodyKey: "device.hue.status.readinessCheckingBody",
    };
  }

  if (input.bridgeUnreachable) {
    return {
      variant: "info",
      titleKey: "device.hue.status.bridgeOfflineTitle",
      bodyKey: "device.hue.status.bridgeOfflineBody",
    };
  }

  if (!input.status) {
    return {
      variant: "info",
      titleKey: "device.hue.status.idleTitle",
      bodyKey: "device.hue.status.idleBody",
    };
  }

  if (input.status.code === "HUE_STREAM_READY") {
    return {
      variant: "success",
      titleKey: "device.hue.status.streamReadyTitle",
      bodyKey: "device.hue.status.streamReadyBody",
      details: input.status.details ?? undefined,
    };
  }

  if (
    input.status.code === "HUE_PAIRING_OK" ||
    input.status.code === "HUE_CREDENTIAL_VALID" ||
    input.status.code === "HUE_AREA_LIST_OK"
  ) {
    return {
      variant: "success",
      titleKey: "device.hue.status.successTitle",
      bodyKey: "device.hue.status.successBody",
      details: input.status.message,
    };
  }

  if (input.status.code === "HUE_STREAM_NOT_READY") {
    return {
      variant: "error",
      titleKey: "device.hue.status.streamNotReadyTitle",
      bodyKey: "device.hue.status.streamNotReadyBody",
      details: input.status.details ?? undefined,
    };
  }

  if (input.credentialState === "needs_repair" || input.status.code.includes("FAILED") || input.status.code.includes("INVALID")) {
    return {
      variant: "error",
      titleKey: "device.hue.status.errorTitle",
      bodyKey: "device.hue.status.errorBody",
      details: input.status.details ?? input.status.message,
    };
  }

  return {
    variant: "info",
    titleKey: "device.hue.status.infoTitle",
    bodyKey: "device.hue.status.infoBody",
    details: input.status.message,
  };
}
