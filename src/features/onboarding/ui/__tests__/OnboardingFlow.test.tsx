import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OnboardingGuardSnapshot } from "../../state/onboardingState";
import { OnboardingFlow } from "../OnboardingFlow";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function flow(guards: OnboardingGuardSnapshot, onComplete = vi.fn()) {
  const props = {
    hasCompleted: false,
    onOpenLights: vi.fn(),
    onOpenDevices: vi.fn(),
    onOpenCalibration: vi.fn(),
    onComplete,
  };
  const view = render(<OnboardingFlow {...props} guards={guards} />);
  // A fresh-but-equal guard object is what App passes on every render.
  const rerender = (next: OnboardingGuardSnapshot) =>
    view.rerender(<OnboardingFlow {...props} guards={{ ...next }} />);
  return { onComplete, rerender };
}

describe("OnboardingFlow", () => {
  // The step moved one place per guard change, so the last guard to flip
  // stranded the banner on the next step even when that step was already done.
  it("walks past every step whose guard already holds, in one change", () => {
    const { onComplete, rerender } = flow({
      hasInteractedWithMode: true,
      hasReachableOutput: false,
      hasSavedCalibration: true,
    });
    expect(screen.getByText("common:ui.onboarding.step2.title")).toBeInTheDocument();

    rerender({ hasInteractedWithMode: true, hasReachableOutput: true, hasSavedCalibration: true });

    expect(screen.queryByText("common:ui.onboarding.step3.title")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("completes on mount when every guard already holds", () => {
    const { onComplete } = flow({
      hasInteractedWithMode: true,
      hasReachableOutput: true,
      hasSavedCalibration: true,
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("stops at the first unmet step", () => {
    const { onComplete } = flow({
      hasInteractedWithMode: true,
      hasReachableOutput: true,
      hasSavedCalibration: false,
    });
    expect(screen.getByText("common:ui.onboarding.step3.title")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
