import { describe, expect, it } from "vitest";

import { HUE_CREDENTIAL_STATUS, HUE_ONBOARDING_STEP } from "@/shared/contracts/hue";
import { normalizeAreas } from "../areaGrouping";
import { deriveStep, toPersistedStep, toStepFromPersisted } from "../onboardingStep";
import type { HueAreaReadiness, HueStep } from "../onboardingTypes";

const ready: HueAreaReadiness = { ready: true, reasons: [], code: "OK", message: "", details: null };
const notReady: HueAreaReadiness = { ...ready, ready: false };

function stateWith(overrides: {
  selectedBridgeId?: string | null;
  credentialState?: string;
  selectedAreaId?: string | null;
  readiness?: HueAreaReadiness;
}) {
  const readinessById = new Map<string, HueAreaReadiness>();
  if (overrides.readiness) {
    readinessById.set("area-1", overrides.readiness);
  }

  return {
    selectedBridgeId: "selectedBridgeId" in overrides ? overrides.selectedBridgeId ?? null : "bridge-1",
    credentialState: (overrides.credentialState ?? HUE_CREDENTIAL_STATUS.VALID) as never,
    selectedAreaId: "selectedAreaId" in overrides ? overrides.selectedAreaId ?? null : "area-1",
    areaGroups: normalizeAreas(
      [{ id: "area-1", name: "Alpha", roomName: "Salon", channelCount: 0, activeStreamer: false }],
      readinessById,
    ),
  };
}

describe("toStepFromPersisted", () => {
  it.each([
    [HUE_ONBOARDING_STEP.PAIR, "pair"],
    [HUE_ONBOARDING_STEP.AREA_SELECT, "area"],
    [HUE_ONBOARDING_STEP.READY, "ready"],
    [HUE_ONBOARDING_STEP.DISCOVER, "discover"],
  ])("maps %s to %s", (persisted, expected) => {
    expect(toStepFromPersisted(persisted)).toBe(expected);
  });

  it("falls back to discover for an absent or unrecognised value", () => {
    expect(toStepFromPersisted(undefined)).toBe("discover");
    expect(toStepFromPersisted("something-else")).toBe("discover");
  });
});

describe("toPersistedStep", () => {
  it("round-trips every step through the persisted form", () => {
    const steps: HueStep[] = ["discover", "pair", "area", "ready"];
    for (const step of steps) {
      expect(toStepFromPersisted(toPersistedStep(step))).toBe(step);
    }
  });
});

describe("deriveStep", () => {
  it("stays on discover until a bridge is selected", () => {
    expect(deriveStep(stateWith({ selectedBridgeId: null }))).toBe("discover");
  });

  it.each([HUE_CREDENTIAL_STATUS.NEEDS_REPAIR, HUE_CREDENTIAL_STATUS.UNKNOWN])(
    "stays on pair while credentials are %s",
    (credentialState) => {
      expect(deriveStep(stateWith({ credentialState, readiness: ready }))).toBe("pair");
    },
  );

  it("moves to area once credentials are valid but no area is selected", () => {
    expect(deriveStep(stateWith({ selectedAreaId: null }))).toBe("area");
  });

  it("stays on area when the selected area exists but is not ready", () => {
    expect(deriveStep(stateWith({ readiness: notReady }))).toBe("area");
  });

  it("stays on area when the selected area id matches nothing in the list", () => {
    expect(deriveStep(stateWith({ selectedAreaId: "area-missing", readiness: ready }))).toBe("area");
  });

  it("reaches ready only with a valid credential and a ready selected area", () => {
    expect(deriveStep(stateWith({ readiness: ready }))).toBe("ready");
  });
});
