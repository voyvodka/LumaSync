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
}

const STEP_TITLE: Record<Exclude<OnboardingStep, "complete">, string> = {
  [ONBOARDING_STEPS.LIGHTS]: "shell:notices.messages.onboarding.lights",
  [ONBOARDING_STEPS.DEVICES]: "shell:notices.messages.onboarding.devices",
  [ONBOARDING_STEPS.LED_SETUP]: "shell:notices.messages.onboarding.ledSetup",
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
      hasCompleted={false}
      onComplete={onComplete}
      guards={{ ...state.guards }}
      guardsLoaded={state.guardsLoaded}
      reachabilityPending={state.reachabilityPending}
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
  hasInteractedWithMode: false,
  hasReachableOutput: false,
  hasSavedCalibration: false,
};
const AWAITING_OUTPUT: OnboardingGuardSnapshot = {
  hasInteractedWithMode: true,
  hasReachableOutput: false,
  hasSavedCalibration: true,
};
const ALL: OnboardingGuardSnapshot = {
  hasInteractedWithMode: true,
  hasReachableOutput: true,
  hasSavedCalibration: true,
};

describe("useOnboardingStep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The step moved one place per guard change, so the last guard to flip
  // stranded the banner on the next step even when that step was already done.
  it("walks past every step whose guard already holds, in one change", async () => {
    const { onComplete, rerender } = flow(AWAITING_OUTPUT);
    await advance(ONBOARDING_REVEAL_SETTLE_MS);
    expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();

    rerender(ALL);

    expect(screen.queryByText("shell:notices.messages.onboarding.ledSetup")).not.toBeInTheDocument();
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
    it("shows nothing until the persisted guards load, then step 1 at once", () => {
      const { rerender } = flow({ guards: NONE, guardsLoaded: false });
      expect(screen.queryByText("shell:notices.messages.onboarding.lights")).not.toBeInTheDocument();

      rerender({ guards: NONE, guardsLoaded: true });

      expect(screen.getByText("shell:notices.messages.onboarding.lights")).toBeInTheDocument();
    });

    // An upgrader whose persisted guards arrive in a later tick than the flag.
    it("never shows step 1 to a user whose persisted guards load already met", () => {
      const { onComplete, rerender } = flow({ guards: NONE, guardsLoaded: false });
      rerender({ guards: { ...NONE, hasSavedCalibration: true }, guardsLoaded: false });
      rerender({ guards: ALL, guardsLoaded: true });

      expect(screen.queryByText("shell:notices.messages.onboarding.lights")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("holds the devices step back while the output guards can still settle", async () => {
      const { onComplete, rerender } = flow({ guards: AWAITING_OUTPUT, guardsLoaded: true });
      expect(screen.queryByText("shell:notices.messages.onboarding.devices")).not.toBeInTheDocument();

      // A remembered strip reconnecting inside the window: no flash, straight to done.
      await advance(ONBOARDING_REVEAL_SETTLE_MS - 1);
      rerender({ guards: ALL, guardsLoaded: true });

      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("shows the devices step once the window passes with nothing reachable", async () => {
      flow({ guards: AWAITING_OUTPUT, guardsLoaded: true });

      await advance(ONBOARDING_REVEAL_SETTLE_MS);

      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });

    it("waits for a bridge probe still out, up to the cap", async () => {
      const { rerender } = flow({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: true });

      await advance(ONBOARDING_REVEAL_SETTLE_MS);
      expect(screen.queryByText("shell:notices.messages.onboarding.devices")).not.toBeInTheDocument();

      await advance(ONBOARDING_REVEAL_CAP_MS - ONBOARDING_REVEAL_SETTLE_MS);
      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();

      // Latched: the probe answering later does not take it away again.
      rerender({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: false });
      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });

    it("shows the devices step as soon as a pending probe answers after the settle window", async () => {
      const { rerender } = flow({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: true });
      await advance(ONBOARDING_REVEAL_SETTLE_MS + 500);
      expect(screen.queryByText("shell:notices.messages.onboarding.devices")).not.toBeInTheDocument();

      rerender({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: false });

      expect(screen.getByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    });
  });
});
