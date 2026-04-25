/**
 * OnboardingFlow — v1.5 W2-B4
 *
 * Top-level controller for the first-run inline onboarding flow. Mounts
 * a single `<OnboardingBanner>` whose copy + primary action is driven
 * by the active onboarding step. The banner sits at the top of the
 * content slot in App.tsx (above the section tabs / settings layout)
 * so it never blocks interaction with the rest of the UI — the user
 * can ignore the banner and explore freely; the banner just narrates.
 *
 * DNA-fit: this is a soft inline overlay, not a full-screen welcome
 * wizard. The latter is explicitly rejected by the project DNA
 * (\"tray-first, never block the user behind multi-page modals\"). The
 * banner takes < 80 px of vertical space and dismisses with one click.
 *
 * Lifecycle:
 *   - Mounts when `hasCompletedOnboarding !== true`.
 *   - The active step advances when the parent reports a guard change
 *     (mode click, output reachable, calibration saved). When the step
 *     transitions to `COMPLETE`, `onComplete` fires and App.tsx flips
 *     the persisted flag to `true`; the next render unmounts this
 *     component for good.
 *   - The dismiss × on the banner forces an immediate `onComplete`
 *     even if the user has not satisfied step 3 — onboarding is a hint,
 *     not a gate.
 *
 * Section deep-links (`onSectionChange`) are supplied by App.tsx — the
 * flow does not import `SECTION_IDS` directly so the contract surface
 * stays in App.tsx where every other section transition lives.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { OnboardingBanner } from "../../../shared/ui/OnboardingBanner";
import {
  INITIAL_ONBOARDING_STEP,
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  type OnboardingGuardSnapshot,
  type OnboardingStep,
  nextStep,
  stepIndex,
} from "../state/onboardingState";

export interface OnboardingFlowProps {
  /** True ⇒ flow does not render at all (persisted-flag short-circuit). */
  hasCompleted: boolean;
  /** Live guard snapshot — drives step advancement. */
  guards: OnboardingGuardSnapshot;
  /** Deep-link handlers — invoked when the primary action button is clicked. */
  onOpenLights: () => void;
  onOpenDevices: () => void;
  onOpenCalibration: () => void;
  /** Fires when the user finishes step 3 OR dismisses the flow. */
  onComplete: () => void;
}

export function OnboardingFlow({
  hasCompleted,
  guards,
  onOpenLights,
  onOpenDevices,
  onOpenCalibration,
  onComplete,
}: OnboardingFlowProps) {
  const { t } = useTranslation("common");

  // Persisted-flag short-circuit — flow does not render at all once the
  // user has finished or skipped onboarding. App.tsx already gates the
  // mount with the same flag, but we double-check here so the component
  // is safe to unconditionally render in tests + storybook.
  const [step, setStep] = useState<OnboardingStep>(INITIAL_ONBOARDING_STEP);

  // Re-evaluate the active step whenever a guard input changes. The
  // state machine only ever advances forwards, so a flip-flop in (e.g.)
  // `hasReachableOutput` does not bounce the user back to step 2 once
  // they have moved past it — that would be a poor UX.
  useEffect(() => {
    setStep((current) => {
      const next = nextStep(current, guards);
      return next;
    });
  }, [guards]);

  // Drive the `onComplete` side effect when the step machine reaches
  // COMPLETE, including the explicit dismiss path below.
  useEffect(() => {
    if (step === ONBOARDING_STEPS.COMPLETE) {
      onComplete();
    }
  }, [step, onComplete]);

  // Banner copy + primary action map per step. Memoised so the banner
  // does not re-render its primary action object on every parent tick.
  const bannerProps = useMemo(() => {
    if (step === ONBOARDING_STEPS.COMPLETE) return null;
    if (step === ONBOARDING_STEPS.LIGHTS) {
      return {
        title: t("ui.onboarding.step1.title"),
        body: t("ui.onboarding.step1.body"),
        primaryAction: {
          label: t("ui.onboarding.step1.action"),
          onClick: onOpenLights,
        },
      };
    }
    if (step === ONBOARDING_STEPS.DEVICES) {
      return {
        title: t("ui.onboarding.step2.title"),
        body: t("ui.onboarding.step2.body"),
        primaryAction: {
          label: t("ui.onboarding.step2.action"),
          onClick: onOpenDevices,
        },
      };
    }
    return {
      title: t("ui.onboarding.step3.title"),
      body: t("ui.onboarding.step3.body"),
      primaryAction: {
        label: t("ui.onboarding.step3.action"),
        onClick: onOpenCalibration,
      },
    };
  }, [step, t, onOpenLights, onOpenDevices, onOpenCalibration]);

  if (hasCompleted) return null;
  if (!bannerProps) return null;

  return (
    <OnboardingBanner
      title={bannerProps.title}
      body={bannerProps.body}
      step={stepIndex(step)}
      totalSteps={ONBOARDING_TOTAL_STEPS}
      primaryAction={bannerProps.primaryAction}
      // Dismiss collapses straight to COMPLETE — the user has opted out
      // of onboarding, but we honor every other choice they have made
      // along the way (mode pick, device pairing). The persisted flag
      // ensures the banner does not re-mount on the next launch.
      onDismiss={() => onComplete()}
      ariaLive="polite"
    />
  );
}
