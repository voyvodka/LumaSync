/**
 * Onboarding state machine
 *
 * The first-run guide is a progressive hint in the shell's notice slot:
 *
 *   1. DEVICES   — connect a USB strip, WLED panel or Hue bridge. Every mode
 *                  but Off is locked until one is reachable, so this is first.
 *   2. LED_SETUP — tell LumaSync how many LEDs sit on each screen edge. Only
 *                  for a local output (USB strip or WLED); a Hue-only setup
 *                  has no LEDs to map and walks straight past it.
 *   3. TURN_ON   — turn on Ambilight, done once a non-Off mode actually runs.
 *
 * The "complete" pseudo-step is a user who finished step 3 or skipped the
 * guide. App.tsx then persists `ShellState.hasCompletedOnboarding = true`.
 * Only that flag is persisted — never the step — so a change of order needs no
 * migration: the step is re-derived from the guards on every launch.
 *
 * The room map is deliberately not a step; see docs/architecture/ui-and-shell.md.
 */
import type { ShellState } from "@/shared/contracts/shell";

/** Discrete onboarding step identifiers. */
export const ONBOARDING_STEPS = {
  DEVICES: "devices",
  LED_SETUP: "led-setup",
  TURN_ON: "turn-on",
  COMPLETE: "complete",
} as const;

export type OnboardingStep =
  (typeof ONBOARDING_STEPS)[keyof typeof ONBOARDING_STEPS];

/** Ordered list — index drives the `1/3` step pill. */
export const ONBOARDING_STEP_ORDER: ReadonlyArray<OnboardingStep> = [
  ONBOARDING_STEPS.DEVICES,
  ONBOARDING_STEPS.LED_SETUP,
  ONBOARDING_STEPS.TURN_ON,
];

/**
 * 1-based step number for the active step (or 0 when complete). Fixed per
 * step, so a Hue-only user goes from 1/3 to 3/3: the skipped step reads as
 * skipped rather than the total shrinking under them.
 */
export function stepIndex(step: OnboardingStep): number {
  const idx = ONBOARDING_STEP_ORDER.indexOf(step);
  return idx === -1 ? 0 : idx + 1;
}

export const ONBOARDING_TOTAL_STEPS = ONBOARDING_STEP_ORDER.length;

/** Inputs the state machine needs to decide whether each step's guard holds. */
export interface OnboardingGuardSnapshot {
  /** At least one output is reachable: a local strip or panel, or a Hue bridge. */
  hasReachableOutput: boolean;
  /**
   * A USB strip or WLED panel has been the output this session — the only
   * outputs LED Setup applies to. Latched by the caller, so an unplug midway
   * through step 2 does not skip it.
   */
  hasLocalOutput: boolean;
  /** A calibration config has been saved at least once. */
  hasSavedCalibration: boolean;
  /** A non-Off mode runs now, or the choice saved at launch was one. */
  hasLightingRun: boolean;
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
    case ONBOARDING_STEPS.DEVICES:
      return guards.hasReachableOutput
        ? ONBOARDING_STEPS.LED_SETUP
        : ONBOARDING_STEPS.DEVICES;
    case ONBOARDING_STEPS.LED_SETUP:
      return !guards.hasLocalOutput || guards.hasSavedCalibration
        ? ONBOARDING_STEPS.TURN_ON
        : ONBOARDING_STEPS.LED_SETUP;
    case ONBOARDING_STEPS.TURN_ON:
      return guards.hasLightingRun
        ? ONBOARDING_STEPS.COMPLETE
        : ONBOARDING_STEPS.TURN_ON;
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
 * What the saved state says before any live guard answers. `outputRemembered`
 * is whether a live guard could still flip on its own — a remembered strip
 * reconnecting, a saved WLED panel re-binding, a paired bridge answering, the
 * saved mode being restored — and so whether a step must wait before showing.
 */
export interface OnboardingBootFacts {
  outputRemembered: boolean;
  /** The last accepted mode choice was not Off, so the user has had lighting running. */
  hasRunLighting: boolean;
}

export const NO_ONBOARDING_BOOT_FACTS: OnboardingBootFacts = {
  outputRemembered: false,
  hasRunLighting: false,
};

export function onboardingBootFacts(
  state: Pick<ShellState, "lastSuccessfulPort" | "lastWledSink" | "lightingMode">,
  hueConfigured: boolean,
): OnboardingBootFacts {
  return {
    outputRemembered: Boolean(state.lastSuccessfulPort) || state.lastWledSink != null || hueConfigured,
    hasRunLighting: state.lightingMode !== undefined && state.lightingMode.kind !== "off",
  };
}

/**
 * How long after launch a step waits before showing, when something is
 * remembered that could still satisfy its guard: a remembered strip reconnects
 * and a paired bridge answers its first probe only after bootstrap, and showing
 * the step meanwhile is what flashed the guide at users who were already set up.
 */
export const ONBOARDING_REVEAL_SETTLE_MS = 3_000;

/** The longer bound while a bridge probe is still out; a dead bridge takes a full HTTP timeout. */
export const ONBOARDING_REVEAL_CAP_MS = 8_000;

export interface OnboardingRevealInput {
  /** A reachability probe that could still satisfy the devices step is out. */
  reachabilityPending: boolean;
  /** See `OnboardingBootFacts.outputRemembered`. */
  outputRemembered: boolean;
}

/**
 * Milliseconds after the persisted guards load before `step` may show. A fresh
 * install remembers nothing, so no live guard can move on its own and step 1
 * shows at once — in place of the "no reachable output" error it explains.
 */
export function onboardingRevealDelayMs(
  step: OnboardingStep,
  { reachabilityPending, outputRemembered }: OnboardingRevealInput,
): number {
  if (step === ONBOARDING_STEPS.COMPLETE || !outputRemembered) return 0;
  return reachabilityPending ? ONBOARDING_REVEAL_CAP_MS : ONBOARDING_REVEAL_SETTLE_MS;
}

/** Where the guide starts, on first run and when the user asks for it again. */
export const INITIAL_ONBOARDING_STEP: OnboardingStep = ONBOARDING_STEPS.DEVICES;
