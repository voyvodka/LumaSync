import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_REVEAL_CAP_MS,
  ONBOARDING_REVEAL_SETTLE_MS,
  ONBOARDING_STEPS,
  type OnboardingGuardSnapshot,
  type OnboardingStep,
} from "../onboardingState";
import { useOnboardingStep, type OnboardingStepInput } from "../useOnboardingStep";

interface FlowState {
  guards: OnboardingGuardSnapshot;
  guardsLoaded?: boolean;
  reachabilityPending?: boolean;
  outputRemembered?: boolean;
  hasCompleted?: boolean;
  restartKey?: number;
}

const STEP_TITLE: Record<Exclude<OnboardingStep, "complete">, string> = {
  [ONBOARDING_STEPS.DEVICES]: "shell:notices.messages.onboarding.devices",
  [ONBOARDING_STEPS.LED_SETUP]: "shell:notices.messages.onboarding.ledSetup",
  [ONBOARDING_STEPS.TURN_ON]: "shell:notices.messages.onboarding.turnOn",
};

/** Renders the shown step the way the notice slot names it. */
function Harness(props: OnboardingStepInput) {
  const { step } = useOnboardingStep(props);
  if (step === null || step === ONBOARDING_STEPS.COMPLETE) return null;
  return <div role="region">{STEP_TITLE[step]}</div>;
}

function flow(initial: OnboardingGuardSnapshot | FlowState, onComplete = vi.fn()) {
  const toState = (next: OnboardingGuardSnapshot | FlowState): FlowState =>
    "guards" in next ? next : { guards: next };
  const element = (state: FlowState) => (
    // A fresh-but-equal guard object is what App passes on every render.
    <Harness
      hasCompleted={state.hasCompleted ?? false}
      onComplete={onComplete}
      guards={{ ...state.guards }}
      guardsLoaded={state.guardsLoaded}
      reachabilityPending={state.reachabilityPending}
      outputRemembered={state.outputRemembered ?? false}
      restartKey={state.restartKey}
    />
  );
  const view = render(element(toState(initial)));
  const rerender = (next: OnboardingGuardSnapshot | FlowState) => view.rerender(element(toState(next)));
  return { onComplete, rerender };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const NONE: OnboardingGuardSnapshot = {
  hasReachableOutput: false,
  hasLocalOutput: false,
  hasSavedCalibration: false,
  hasLightingRun: false,
};
/** A set-up user whose remembered strip has not reconnected yet. */
const AWAITING_OUTPUT: OnboardingGuardSnapshot = {
  hasReachableOutput: false,
  hasLocalOutput: false,
  hasSavedCalibration: true,
  hasLightingRun: true,
};
const ALL: OnboardingGuardSnapshot = {
  hasReachableOutput: true,
  hasLocalOutput: true,
  hasSavedCalibration: true,
  hasLightingRun: true,
};
const STRIP_UNCALIBRATED: OnboardingGuardSnapshot = { ...NONE, hasReachableOutput: true, hasLocalOutput: true };
const HUE_ONLY: OnboardingGuardSnapshot = { ...NONE, hasReachableOutput: true };

describe("useOnboardingStep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the order", () => {
    it("starts with the devices step, since every mode but Off is locked without one", () => {
      flow(NONE);
      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });

    it("asks for the LED layout next when a strip or WLED panel is the output", () => {
      const { rerender } = flow(NONE);
      rerender(STRIP_UNCALIBRATED);
      expect(screen.getByText("shell:notices.messages.onboarding.ledSetup")).toBeInTheDocument();

      rerender({ ...STRIP_UNCALIBRATED, hasSavedCalibration: true });
      expect(screen.getByText("shell:notices.messages.onboarding.turnOn")).toBeInTheDocument();
    });

    // Hue-only users were stuck on the LED step, which a bridge can never pass.
    it("walks a Hue-only user straight past the LED step", () => {
      const { rerender } = flow(NONE);
      rerender(HUE_ONLY);
      expect(screen.getByText("shell:notices.messages.onboarding.turnOn")).toBeInTheDocument();
    });

    it("completes once a non-Off mode runs", () => {
      const { onComplete, rerender } = flow(HUE_ONLY);
      expect(onComplete).not.toHaveBeenCalled();

      rerender({ ...HUE_ONLY, hasLightingRun: true });

      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    // An unplug midway through the LED step must not count as "no strip, skip it".
    it("never moves backwards when an output drops", () => {
      const { rerender } = flow(HUE_ONLY);
      rerender({ ...HUE_ONLY, hasReachableOutput: false });
      expect(screen.getByText("shell:notices.messages.onboarding.turnOn")).toBeInTheDocument();
    });
  });

  // The step moved one place per guard change, so the last guard to flip
  // stranded the banner on the next step even when that step was already done.
  it("walks past every step whose guard already holds, in one change", async () => {
    const { onComplete, rerender } = flow({ guards: AWAITING_OUTPUT, outputRemembered: true });
    await advance(ONBOARDING_REVEAL_SETTLE_MS);
    expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();

    rerender({ guards: ALL, outputRemembered: true });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("completes on mount when every guard already holds", () => {
    const { onComplete } = flow(ALL);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("stops at the first unmet step", () => {
    const { onComplete } = flow({ ...ALL, hasSavedCalibration: false });
    expect(screen.getByText("shell:notices.messages.onboarding.ledSetup")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  describe("revealing only a settled step", () => {
    it("shows nothing until the persisted guards load, then a fresh install's step 1 at once", () => {
      const { rerender } = flow({ guards: NONE, guardsLoaded: false, outputRemembered: false });
      expect(screen.queryByRole("region")).not.toBeInTheDocument();

      rerender({ guards: NONE, guardsLoaded: true, outputRemembered: false });

      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });

    // An upgrader whose persisted guards arrive in a later tick than the flag.
    it("never shows step 1 to a user whose persisted guards load already met", () => {
      const { onComplete, rerender } = flow({ guards: NONE, guardsLoaded: false, outputRemembered: true });
      rerender({ guards: { ...NONE, hasSavedCalibration: true }, guardsLoaded: false, outputRemembered: true });
      rerender({ guards: ALL, guardsLoaded: true, outputRemembered: true });

      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("holds the step back while a remembered output can still settle", async () => {
      const { onComplete, rerender } = flow({ guards: AWAITING_OUTPUT, outputRemembered: true });
      expect(screen.queryByRole("region")).not.toBeInTheDocument();

      // A remembered strip reconnecting inside the window: no flash, straight to done.
      await advance(ONBOARDING_REVEAL_SETTLE_MS - 1);
      rerender({ guards: ALL, outputRemembered: true });

      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("shows the step once the window passes with nothing reachable", async () => {
      flow({ guards: AWAITING_OUTPUT, outputRemembered: true });

      await advance(ONBOARDING_REVEAL_SETTLE_MS);

      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });

    it("waits for a bridge probe still out, up to the cap", async () => {
      const { rerender } = flow({ guards: AWAITING_OUTPUT, reachabilityPending: true, outputRemembered: true });

      await advance(ONBOARDING_REVEAL_SETTLE_MS);
      expect(screen.queryByText("shell:notices.messages.onboarding.devices")).not.toBeInTheDocument();

      await advance(ONBOARDING_REVEAL_CAP_MS - ONBOARDING_REVEAL_SETTLE_MS);
      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();

      // Latched: the probe answering later does not take it away again.
      rerender({ guards: AWAITING_OUTPUT, reachabilityPending: false, outputRemembered: true });
      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });

    it("shows the step as soon as a pending probe answers after the settle window", async () => {
      const { rerender } = flow({ guards: AWAITING_OUTPUT, reachabilityPending: true, outputRemembered: true });
      await advance(ONBOARDING_REVEAL_SETTLE_MS + 500);
      expect(screen.queryByText("shell:notices.messages.onboarding.devices")).not.toBeInTheDocument();

      rerender({ guards: AWAITING_OUTPUT, reachabilityPending: false, outputRemembered: true });

      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });
  });

  describe("showing the guide again", () => {
    it("starts over from the first unmet step and shows it at once", async () => {
      const onComplete = vi.fn<() => void>();
      const { rerender } = flow({ guards: HUE_ONLY, outputRemembered: true }, onComplete);
      rerender({ guards: HUE_ONLY, outputRemembered: true, hasCompleted: true });
      expect(screen.queryByRole("region")).not.toBeInTheDocument();

      // A remembered output would hold a launch reveal back; the user asked, so it shows now.
      rerender({ guards: HUE_ONLY, outputRemembered: true, hasCompleted: false, restartKey: 1 });

      expect(screen.getByText("shell:notices.messages.onboarding.turnOn")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();

      // Still forwards-only after a restart: the bridge dropping does not send it back.
      rerender({
        guards: { ...HUE_ONLY, hasReachableOutput: false },
        outputRemembered: true,
        hasCompleted: false,
        restartKey: 1,
      });
      expect(screen.getByText("shell:notices.messages.onboarding.turnOn")).toBeInTheDocument();
    });

    // The guide completed once; without the reset it stayed on COMPLETE for good.
    it("comes back after the guide completed, and completes again when its step is done", () => {
      const onComplete = vi.fn<() => void>();
      const { rerender } = flow({ guards: ALL }, onComplete);
      expect(onComplete).toHaveBeenCalledTimes(1);
      rerender({ guards: ALL, hasCompleted: true });

      rerender({ guards: HUE_ONLY, hasCompleted: false, restartKey: 1 });
      expect(screen.getByText("shell:notices.messages.onboarding.turnOn")).toBeInTheDocument();

      rerender({ guards: { ...HUE_ONLY, hasLightingRun: true }, hasCompleted: false, restartKey: 1 });
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(2);
    });
  });
});
