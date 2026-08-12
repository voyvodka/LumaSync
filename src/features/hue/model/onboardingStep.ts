import {
  HUE_CREDENTIAL_STATUS,
  HUE_ONBOARDING_STEP,
  type HueOnboardingStep,
} from "@/shared/contracts/hue";
import { flattenAreaGroups } from "./areaGrouping";
import type { HueOnboardingState, HueStep } from "./onboardingTypes";

export function toStepFromPersisted(value: string | undefined): HueStep {
  if (value === HUE_ONBOARDING_STEP.PAIR) {
    return "pair";
  }

  if (value === HUE_ONBOARDING_STEP.AREA_SELECT) {
    return "area";
  }

  if (value === HUE_ONBOARDING_STEP.READY) {
    return "ready";
  }

  return "discover";
}

export function toPersistedStep(step: HueStep): HueOnboardingStep {
  return step === "discover"
    ? HUE_ONBOARDING_STEP.DISCOVER
    : step === "pair"
      ? HUE_ONBOARDING_STEP.PAIR
      : step === "area"
        ? HUE_ONBOARDING_STEP.AREA_SELECT
        : HUE_ONBOARDING_STEP.READY;
}

export function deriveStep(state: Pick<HueOnboardingState, "selectedBridgeId" | "credentialState" | "selectedAreaId" | "areaGroups">): HueStep {
  if (!state.selectedBridgeId) {
    return "discover";
  }

  if (state.credentialState !== HUE_CREDENTIAL_STATUS.VALID) {
    return "pair";
  }

  if (!state.selectedAreaId) {
    return "area";
  }

  const selectedArea = flattenAreaGroups(state.areaGroups).find((area) => area.id === state.selectedAreaId);
  if (!selectedArea?.readiness?.ready) {
    return "area";
  }

  return "ready";
}
