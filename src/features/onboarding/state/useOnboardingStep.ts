/**
 * The first-run flow's controller. It decides which step is live and when it
 * may be shown; the shell's notice queue decides how and whether it is shown
 * beside everything else (`buildShellNotices`).
 *
 * DNA-fit: a hint in the notice slot, never a full-screen welcome wizard, and
 * skippable with one click — onboarding is a hint, not a gate.
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
  /** Something saved could still satisfy a guard on its own; see `OnboardingBootFacts`. */
  outputRemembered?: boolean;
  /**
   * Bumped when the user asks for the guide again: it starts over from step 1
   * and shows at once, since the user is looking at the window.
   */
  restartKey?: number;
  /** Fires once the machine reaches COMPLETE. The skip path is the caller's. */
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
  outputRemembered = true,
  restartKey = 0,
  onComplete,
}: OnboardingStepInput): OnboardingStepState {
  const [step, setStep] = useState<OnboardingStep>(INITIAL_ONBOARDING_STEP);
  // Latched: once shown, the step leaves only by completing or being skipped.
  const [revealed, setRevealed] = useState(false);

  const { hasReachableOutput, hasLocalOutput, hasSavedCalibration, hasLightingRun } = guards;

  // Adjusted during render, so the restarted guide never renders one frame
  // from the COMPLETE it is leaving. Stored settled, like the effect below
  // stores it, or a later guard flip could walk the shown step back.
  const [seenRestartKey, setSeenRestartKey] = useState(restartKey);
  let current = step;
  if (restartKey !== seenRestartKey) {
    current = settleStep(INITIAL_ONBOARDING_STEP, guards);
    setSeenRestartKey(restartKey);
    setStep(current);
    setRevealed(true);
  }

  // Only ever advances forwards, so a flip-flop in (e.g.) `hasReachableOutput`
  // does not bounce the user back to step 1 once past it. Keyed on the four
  // booleans, not the object: App passes a fresh literal every render, and
  // settling to a fixpoint is what makes one run enough.
  useEffect(() => {
    setStep((prev) =>
      settleStep(prev, { hasReachableOutput, hasLocalOutput, hasSavedCalibration, hasLightingRun }),
    );
  }, [hasReachableOutput, hasLocalOutput, hasSavedCalibration, hasLightingRun]);
  // Settled during render too, so the reveal below never judges the step the
  // effect above is about to replace.
  const shownStep = settleStep(current, { hasReachableOutput, hasLocalOutput, hasSavedCalibration, hasLightingRun });

  const loadedAtRef = useRef<number | null>(null);
  const revealDelay = onboardingRevealDelayMs(shownStep, { reachabilityPending, outputRemembered });
  // With nothing that could settle on its own, the step shows on the very
  // render the guards load — a frame later is a frame of the error it replaces.
  const shownNow = revealed || (guardsLoaded && revealDelay <= 0);
  useEffect(() => {
    if (revealed || !guardsLoaded || shownStep === ONBOARDING_STEPS.COMPLETE) return;
    if (loadedAtRef.current === null) loadedAtRef.current = Date.now();
    const remaining = revealDelay - (Date.now() - loadedAtRef.current);
    if (remaining <= 0) {
      setRevealed(true);
      return;
    }
    const timerId = window.setTimeout(() => setRevealed(true), remaining);
    return () => window.clearTimeout(timerId);
  }, [revealed, guardsLoaded, shownStep, revealDelay]);

  useEffect(() => {
    if (step === ONBOARDING_STEPS.COMPLETE) {
      onComplete();
    }
  }, [step, onComplete]);

  if (hasCompleted || shownStep === ONBOARDING_STEPS.COMPLETE) return { step: null, pending: false };
  if (!shownNow) return { step: null, pending: true };
  return { step: shownStep, pending: false };
}
