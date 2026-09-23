/**
 * The first-run flow's controller. It decides which step is live and when it
 * may be shown; the shell's notice queue decides how and whether it is shown
 * beside everything else (`buildShellNotices`).
 *
 * DNA-fit: a hint in the notice slot, never a full-screen welcome wizard, and
 * dismissible with one click — onboarding is a hint, not a gate.
 */
import { useEffect, useRef, useState } from "react";

import {
  INITIAL_ONBOARDING_STEP,
  onboardingRevealDelayMs,
  ONBOARDING_STEPS,
  type OnboardingGuardSnapshot,
  type OnboardingStep,
  settleStep,
} from "./onboardingState";

export interface OnboardingStepInput {
  /** True ⇒ nothing is shown (persisted-flag short-circuit). */
  hasCompleted: boolean;
  /** Live guard snapshot — drives step advancement. */
  guards: OnboardingGuardSnapshot;
  /**
   * The persisted guards have been read. Until then the guards are defaults,
   * and a step shown from them flashes at a user who is already past it.
   */
  guardsLoaded?: boolean;
  /** A reachability probe that could still satisfy the devices step is out. */
  reachabilityPending?: boolean;
  /** Fires once the machine reaches COMPLETE. The dismiss path is the caller's. */
  onComplete: () => void;
}

export interface OnboardingStepState {
  /** The step to show now, or `null` while hidden, held back, or done. */
  step: OnboardingStep | null;
  /** A step exists that has not been revealed yet. */
  pending: boolean;
}

export function useOnboardingStep({
  hasCompleted,
  guards,
  guardsLoaded = true,
  reachabilityPending = false,
  onComplete,
}: OnboardingStepInput): OnboardingStepState {
  const [step, setStep] = useState<OnboardingStep>(INITIAL_ONBOARDING_STEP);

  // Only ever advances forwards, so a flip-flop in (e.g.) `hasReachableOutput`
  // does not bounce the user back to step 2 once past it. Keyed on the three
  // booleans, not the object: App passes a fresh literal every render, and
  // settling to a fixpoint is what makes one run enough.
  const { hasInteractedWithMode, hasReachableOutput, hasSavedCalibration } = guards;
  useEffect(() => {
    setStep((current) =>
      settleStep(current, { hasInteractedWithMode, hasReachableOutput, hasSavedCalibration }),
    );
  }, [hasInteractedWithMode, hasReachableOutput, hasSavedCalibration]);
  // Settled during render too, so the reveal below never judges the step the
  // effect above is about to replace.
  const shownStep = settleStep(step, { hasInteractedWithMode, hasReachableOutput, hasSavedCalibration });

  // Latched: once shown, the step leaves only by completing or dismissing.
  const [revealed, setRevealed] = useState(false);
  const loadedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (revealed || !guardsLoaded || shownStep === ONBOARDING_STEPS.COMPLETE) return;
    if (loadedAtRef.current === null) loadedAtRef.current = Date.now();
    const remaining =
      onboardingRevealDelayMs(shownStep, reachabilityPending) - (Date.now() - loadedAtRef.current);
    if (remaining <= 0) {
      setRevealed(true);
      return;
    }
    const timerId = window.setTimeout(() => setRevealed(true), remaining);
    return () => window.clearTimeout(timerId);
  }, [revealed, guardsLoaded, shownStep, reachabilityPending]);

  useEffect(() => {
    if (step === ONBOARDING_STEPS.COMPLETE) {
      onComplete();
    }
  }, [step, onComplete]);

  if (hasCompleted || shownStep === ONBOARDING_STEPS.COMPLETE) return { step: null, pending: false };
  if (!revealed) return { step: null, pending: true };
  return { step: shownStep, pending: false };
}
