import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_REVEAL_CAP_MS,
  ONBOARDING_REVEAL_SETTLE_MS,
  type OnboardingGuardSnapshot,
} from "../../state/onboardingState";
import { OnboardingFlow } from "../OnboardingFlow";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

interface FlowState {
  guards: OnboardingGuardSnapshot;
  guardsLoaded?: boolean;
  reachabilityPending?: boolean;
}

function flow(initial: OnboardingGuardSnapshot | FlowState, onComplete = vi.fn()) {
  const toState = (next: OnboardingGuardSnapshot | FlowState): FlowState =>
    "guards" in next ? next : { guards: next };
  const props = {
    hasCompleted: false,
    onOpenLights: vi.fn(),
    onOpenDevices: vi.fn(),
    onOpenCalibration: vi.fn(),
    onComplete,
  };
  const element = (state: FlowState) => (
    // A fresh-but-equal guard object is what App passes on every render.
    <OnboardingFlow
      {...props}
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

describe("OnboardingFlow", () => {
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
    expect(screen.getByText("common:ui.onboarding.step2.title")).toBeInTheDocument();

    rerender(ALL);

    expect(screen.queryByText("common:ui.onboarding.step3.title")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("completes on mount when every guard already holds", () => {
    const { onComplete } = flow(ALL);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("stops at the first unmet step", () => {
    const { onComplete } = flow({ ...ALL, hasSavedCalibration: false });
    expect(screen.getByText("common:ui.onboarding.step3.title")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  describe("revealing only a settled step", () => {
    it("shows nothing until the persisted guards load, then step 1 at once", () => {
      const { rerender } = flow({ guards: NONE, guardsLoaded: false });
      expect(screen.queryByText("common:ui.onboarding.step1.title")).not.toBeInTheDocument();

      rerender({ guards: NONE, guardsLoaded: true });

      expect(screen.getByText("common:ui.onboarding.step1.title")).toBeInTheDocument();
    });

    // An upgrader whose persisted guards arrive in a later tick than the flag.
    it("never shows step 1 to a user whose persisted guards load already met", () => {
      const { onComplete, rerender } = flow({ guards: NONE, guardsLoaded: false });
      rerender({ guards: { ...NONE, hasSavedCalibration: true }, guardsLoaded: false });
      rerender({ guards: ALL, guardsLoaded: true });

      expect(screen.queryByText("common:ui.onboarding.step1.title")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("holds the devices step back while the output guards can still settle", async () => {
      const { onComplete, rerender } = flow({ guards: AWAITING_OUTPUT, guardsLoaded: true });
      expect(screen.queryByText("common:ui.onboarding.step2.title")).not.toBeInTheDocument();

      // A remembered strip reconnecting inside the window: no flash, straight to done.
      await advance(ONBOARDING_REVEAL_SETTLE_MS - 1);
      rerender({ guards: ALL, guardsLoaded: true });

      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("shows the devices step once the window passes with nothing reachable", async () => {
      flow({ guards: AWAITING_OUTPUT, guardsLoaded: true });

      await advance(ONBOARDING_REVEAL_SETTLE_MS);

      expect(screen.getByText("common:ui.onboarding.step2.title")).toBeInTheDocument();
    });

    it("waits for a bridge probe still out, up to the cap", async () => {
      const { rerender } = flow({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: true });

      await advance(ONBOARDING_REVEAL_SETTLE_MS);
      expect(screen.queryByText("common:ui.onboarding.step2.title")).not.toBeInTheDocument();

      await advance(ONBOARDING_REVEAL_CAP_MS - ONBOARDING_REVEAL_SETTLE_MS);
      expect(screen.getByText("common:ui.onboarding.step2.title")).toBeInTheDocument();

      // Latched: the probe answering later does not take it away again.
      rerender({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: false });
      expect(screen.getByText("common:ui.onboarding.step2.title")).toBeInTheDocument();
    });

    it("shows the devices step as soon as a pending probe answers after the settle window", async () => {
      const { rerender } = flow({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: true });
      await advance(ONBOARDING_REVEAL_SETTLE_MS + 500);
      expect(screen.queryByText("common:ui.onboarding.step2.title")).not.toBeInTheDocument();

      rerender({ guards: AWAITING_OUTPUT, guardsLoaded: true, reachabilityPending: false });

      expect(screen.getByText("common:ui.onboarding.step2.title")).toBeInTheDocument();
    });
  });
});
