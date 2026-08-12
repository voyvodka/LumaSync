import type { TranslationKey } from "@/features/i18n/catalogue";
import type { HueCredentialStatus } from "@/shared/contracts/hue";
import type { CommandStatus } from "./hueOnboardingApi";

/** Renderable view model for the Hue pairing/onboarding status card. */
export interface HueStatusCardModel {
  variant: "success" | "error" | "info";
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  details?: string;
}

/** Input to `buildHueStatusCard`. */
export interface HueStatusCardInput {
  status: CommandStatus | null;
  credentialState: HueCredentialStatus;
  isValidatingCredential: boolean;
  isPairing: boolean;
  isCheckingReadiness: boolean;
  bridgeUnreachable?: boolean;
}

/** Derives the Hue status card model, prioritizing in-progress operations over the last command result. */
export function buildHueStatusCard(input: HueStatusCardInput): HueStatusCardModel {
  if (input.isValidatingCredential) {
    return {
      variant: "info",
      titleKey: "hue:status.validatingTitle",
      bodyKey: "hue:status.validatingBody",
    };
  }

  if (input.isPairing) {
    return {
      variant: "info",
      titleKey: "hue:status.pairingTitle",
      bodyKey: "hue:status.pairingBody",
    };
  }

  if (input.isCheckingReadiness) {
    return {
      variant: "info",
      titleKey: "hue:status.readinessCheckingTitle",
      bodyKey: "hue:status.readinessCheckingBody",
    };
  }

  if (input.bridgeUnreachable) {
    return {
      variant: "info",
      titleKey: "hue:status.bridgeOfflineTitle",
      bodyKey: "hue:status.bridgeOfflineBody",
    };
  }

  if (!input.status) {
    return {
      variant: "info",
      titleKey: "hue:status.idleTitle",
      bodyKey: "hue:status.idleBody",
    };
  }

  if (input.status.code === "HUE_STREAM_READY") {
    return {
      variant: "success",
      titleKey: "hue:status.streamReadyTitle",
      bodyKey: "hue:status.streamReadyBody",
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
      titleKey: "hue:status.successTitle",
      bodyKey: "hue:status.successBody",
      details: input.status.message,
    };
  }

  if (input.status.code === "HUE_STREAM_NOT_READY") {
    return {
      variant: "error",
      titleKey: "hue:status.streamNotReadyTitle",
      bodyKey: "hue:status.streamNotReadyBody",
      details: input.status.details ?? undefined,
    };
  }

  if (input.credentialState === "needs_repair" || input.status.code.includes("FAILED") || input.status.code.includes("INVALID")) {
    return {
      variant: "error",
      titleKey: "hue:status.errorTitle",
      bodyKey: "hue:status.errorBody",
      details: input.status.details ?? input.status.message,
    };
  }

  return {
    variant: "info",
    titleKey: "hue:status.infoTitle",
    bodyKey: "hue:status.infoBody",
    details: input.status.message,
  };
}
