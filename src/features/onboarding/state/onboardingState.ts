/**
 * Onboarding state machine — v1.5 W2-B4
 *
 * The first-run onboarding flow is a 3-step progressive banner that
 * walks a fresh user through:
 *
 *   1. LIGHTS  — choose a lighting mode (Off / Ambilight / Solid).
 *   2. DEVICES — connect a USB controller or pair a Hue bridge so the
 *                lighting modes have somewhere to send frames.
 *   3. LED-SETUP — calibrate the LED layout so Ambilight maps the
 *                  screen edges to physical strips correctly.
 *
 * The "complete" pseudo-step represents a user who has either finished
 * step 3 or explicitly skipped the flow (the dismiss × on the banner).
 * Once we land on `complete`, App.tsx flips
 * `ShellState.hasCompletedOnboarding` to `true` and the flow unmounts
 * for good.
 *
 * Why a state machine: the steps cannot advance in arbitrary order. The
 * lights step requires the user to pick a non-Off mode (any of the
 * three is fine — even \"Off\" is a valid acknowledgment, but we wait
 * for any deliberate click before advancing). The devices step requires
 * at least one reachable output. The LED-setup step requires a saved
 * calibration. Hand-rolling these advance guards inline in App.tsx
 * would mean three boolean flags and a tangle of `useEffect`s — the
 * machine here keeps the rules localised and testable.
 */

/** Discrete onboarding step identifiers. */
export const ONBOARDING_STEPS = {
  LIGHTS: "lights",
  DEVICES: "devices",
  LED_SETUP: "led-setup",
  COMPLETE: "complete",
} as const;

export type OnboardingStep =
  (typeof ONBOARDING_STEPS)[keyof typeof ONBOARDING_STEPS];

/** Ordered list — index drives the `1/3` step pill. */
export const ONBOARDING_STEP_ORDER: ReadonlyArray<OnboardingStep> = [
  ONBOARDING_STEPS.LIGHTS,
  ONBOARDING_STEPS.DEVICES,
  ONBOARDING_STEPS.LED_SETUP,
];

/**
 * 1-based step number for the active step (or 0 when complete). Used
 * by the OnboardingBanner step pill — the banner only renders on
 * non-complete steps so a 0 will never reach the UI.
 */
export function stepIndex(step: OnboardingStep): number {
  const idx = ONBOARDING_STEP_ORDER.indexOf(step);
  return idx === -1 ? 0 : idx + 1;
}

/**
 * Total visible step count — the constant is sourced here so a future
 * fourth step (e.g. "enable startup") only needs the array edit, not a
 * scan for hardcoded "3" literals across the UI.
 */
export const ONBOARDING_TOTAL_STEPS = ONBOARDING_STEP_ORDER.length;

/**
 * Inputs the state machine needs to decide whether each step's
 * advance guard is satisfied. Mirrors the props `OnboardingFlow`
 * already receives from App.tsx so wiring is a 1:1 forward.
 */
export interface OnboardingGuardSnapshot {
  /** True once the user has clicked any mode button at least once. */
  hasInteractedWithMode: boolean;
  /** True when at least one output target is reachable (USB or Hue). */
  hasReachableOutput: boolean;
  /** True once a calibration config has been saved at least once. */
  hasSavedCalibration: boolean;
}

/**
 * Decide the next step given the current step and a guard snapshot.
 * Returns the same step when the guard is not satisfied so the caller
 * can re-render without flipping anything.
 */
export function nextStep(
  current: OnboardingStep,
  guards: OnboardingGuardSnapshot,
): OnboardingStep {
  switch (current) {
    case ONBOARDING_STEPS.LIGHTS:
      return guards.hasInteractedWithMode
        ? ONBOARDING_STEPS.DEVICES
        : ONBOARDING_STEPS.LIGHTS;
    case ONBOARDING_STEPS.DEVICES:
      return guards.hasReachableOutput
        ? ONBOARDING_STEPS.LED_SETUP
        : ONBOARDING_STEPS.DEVICES;
    case ONBOARDING_STEPS.LED_SETUP:
      return guards.hasSavedCalibration
        ? ONBOARDING_STEPS.COMPLETE
        : ONBOARDING_STEPS.LED_SETUP;
    case ONBOARDING_STEPS.COMPLETE:
    default:
      return ONBOARDING_STEPS.COMPLETE;
  }
}

/**
 * Advance until no guard moves the step any further. `nextStep` moves one step
 * per call, so a user whose later guards already hold (calibration saved on an
 * earlier install, a strip already connected) must not wait for an unrelated
 * re-render to walk past each one.
 */
export function settleStep(
  current: OnboardingStep,
  guards: OnboardingGuardSnapshot,
): OnboardingStep {
  let step = current;
  // Bounded by the step count, so a future non-monotonic guard cannot spin.
  for (let i = 0; i <= ONBOARDING_STEP_ORDER.length; i += 1) {
    const next = nextStep(step, guards);
    if (next === step) return step;
    step = next;
  }
  return step;
}

/**
 * How long after launch the devices step waits before showing. Its guard is
 * live, not persisted: a remembered strip reconnects and a paired bridge
 * answers its first probe only after bootstrap, and showing the step in the
 * meantime is what flashed the banner at users who were already set up.
 */
export const ONBOARDING_REVEAL_SETTLE_MS = 3_000;

/** The longer bound while a bridge probe is still out; a dead bridge takes a full HTTP timeout. */
export const ONBOARDING_REVEAL_CAP_MS = 8_000;

/**
 * Milliseconds after the persisted guards load before `step` may show. The
 * lights and LED-setup guards are persisted, so their steps are already final.
 */
export function onboardingRevealDelayMs(step: OnboardingStep, reachabilityPending: boolean): number {
  if (step !== ONBOARDING_STEPS.DEVICES) return 0;
  return reachabilityPending ? ONBOARDING_REVEAL_CAP_MS : ONBOARDING_REVEAL_SETTLE_MS;
}

/**
 * Initial step. Always `LIGHTS` for users who do not have
 * `hasCompletedOnboarding === true` set on disk; the banner mounts and
 * begins the walk-through.
 */
export const INITIAL_ONBOARDING_STEP: OnboardingStep = ONBOARDING_STEPS.LIGHTS;
