import { describe, expect, it } from "vitest";

import {
  ONBOARDING_REVEAL_CAP_MS,
  ONBOARDING_REVEAL_SETTLE_MS,
  ONBOARDING_STEPS,
  onboardingBootFacts,
  onboardingRevealDelayMs,
  stepIndex,
} from "../onboardingState";

describe("onboardingBootFacts", () => {
  it("remembers an output from a port, a WLED panel or a paired bridge", () => {
    expect(onboardingBootFacts({}, false).outputRemembered).toBe(false);
    expect(onboardingBootFacts({ lastSuccessfulPort: "COM3" }, false).outputRemembered).toBe(true);
    expect(
      onboardingBootFacts({ lastWledSink: { ip: "192.168.1.40" } as never }, false).outputRemembered,
    ).toBe(true);
    expect(onboardingBootFacts({}, true).outputRemembered).toBe(true);
  });

  // The guide's last step asks for a mode that runs; Off never did.
  it("counts a saved mode as lighting that ran unless it is Off", () => {
    expect(onboardingBootFacts({}, false).hasRunLighting).toBe(false);
    expect(onboardingBootFacts({ lightingMode: { kind: "off" } }, false).hasRunLighting).toBe(false);
    expect(onboardingBootFacts({ lightingMode: { kind: "ambilight" } }, false).hasRunLighting).toBe(true);
    expect(onboardingBootFacts({ lightingMode: { kind: "solid" } }, false).hasRunLighting).toBe(true);
  });
});

describe("onboardingRevealDelayMs", () => {
  // Nothing remembered can reconnect, so a fresh install's step 1 is final.
  it("shows at once when nothing remembered could settle a guard", () => {
    expect(
      onboardingRevealDelayMs(ONBOARDING_STEPS.DEVICES, { reachabilityPending: false, outputRemembered: false }),
    ).toBe(0);
  });

  it("waits for a remembered output, longer while a bridge probe is out", () => {
    expect(
      onboardingRevealDelayMs(ONBOARDING_STEPS.TURN_ON, { reachabilityPending: false, outputRemembered: true }),
    ).toBe(ONBOARDING_REVEAL_SETTLE_MS);
    expect(
      onboardingRevealDelayMs(ONBOARDING_STEPS.DEVICES, { reachabilityPending: true, outputRemembered: true }),
    ).toBe(ONBOARDING_REVEAL_CAP_MS);
  });
});

it("numbers the steps devices, LED setup, turn on", () => {
  expect([ONBOARDING_STEPS.DEVICES, ONBOARDING_STEPS.LED_SETUP, ONBOARDING_STEPS.TURN_ON].map(stepIndex)).toEqual([
    1, 2, 3,
  ]);
});
