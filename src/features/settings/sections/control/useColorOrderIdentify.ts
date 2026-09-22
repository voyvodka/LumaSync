// Guided colour-order identification: light each wire slot with the
// `channelProbe` test pattern, ask which colour the strip shows, and save the
// three answers as the order. The probe pins the identity order, so the answers
// read literally: green, red, blue ⇒ "grb" — see docs/architecture/device-output.md.

import { useCallback, useEffect, useRef, useState } from "react";

import { LED_COLOR_ORDER, type LedColorOrder } from "@/shared/contracts/device";
import { LED_TEST_STATUS, type LedTestPatternResult } from "@/shared/contracts/preview";
import { startLedTestPattern, stopLedTestPattern } from "@/features/preview/previewApi";

export type ProbeSlot = 0 | 1 | 2;
export type ProbeColor = "r" | "g" | "b";
export type ProbeAnswer = ProbeColor | "other";

export type IdentifyFailure =
  /** The user saw something other than pure red, green or blue, or nothing. */
  | "other"
  /** The probe rendered to the preview only — no strip received it. */
  | "notSending"
  | "noCalibration"
  | "startFailed"
  | "saveFailed"
  /** The order was saved but the probe could not be confirmed stopped. */
  | "stopFailed";

export type IdentifyState =
  | { step: "idle" }
  | {
      step: "probe";
      slot: ProbeSlot;
      answers: ProbeColor[];
      /** A start (or the stop after "something else") is in flight. */
      pending: boolean;
      /** The colour just offered was already given for an earlier slot. */
      duplicate: ProbeColor | null;
    }
  | { step: "result"; order: LedColorOrder; pending: boolean }
  | { step: "verify"; order: LedColorOrder; previous: LedColorOrder; pending: boolean }
  | { step: "failed"; reason: IdentifyFailure; order?: LedColorOrder };

/** Bright enough to judge a hue across a room, short of full scale. */
export const PROBE_BRIGHTNESS = 0.5;

const ORDER_VALUES: ReadonlySet<string> = new Set(Object.values(LED_COLOR_ORDER));

/** Three distinct answers, one per slot, spell the order to save. */
export function colorOrderFromAnswers(answers: readonly ProbeColor[]): LedColorOrder | null {
  if (answers.length !== 3 || new Set(answers).size !== 3) return null;
  const joined = answers.join("");
  return ORDER_VALUES.has(joined) ? (joined as LedColorOrder) : null;
}

export interface ColorOrderIdentifyDeps {
  start?: typeof startLedTestPattern;
  stop?: typeof stopLedTestPattern;
  /** Persist `ledColorOrder`. Must reject on failure. */
  save: (order: LedColorOrder) => Promise<void>;
  /** Retune the running output. Only ever called with no probe running. */
  onApplied: (order: LedColorOrder) => void;
  /** The order in effect before identification, for the verify step's undo. */
  current: LedColorOrder;
}

export interface ColorOrderIdentify {
  state: IdentifyState;
  begin: () => void;
  answer: (answer: ProbeAnswer) => void;
  /** Save the identified order (or retry after a failed stop). */
  apply: () => void;
  /** Verify step: the colours look right. */
  keep: () => void;
  /** Verify step: put the previous order back. */
  undo: () => void;
  /** Stop the probe if it is running and change nothing. */
  cancel: () => void;
}

function probeStartFailure(result: LedTestPatternResult): IdentifyFailure | null {
  switch (result.status.code) {
    case LED_TEST_STATUS.PATTERN_STARTED:
      return result.previewOnly ? "notSending" : null;
    case LED_TEST_STATUS.PATTERN_PREVIEW_ONLY:
      return "notSending";
    case LED_TEST_STATUS.PATTERN_NO_CALIBRATION:
      return "noCalibration";
    default:
      return "startFailed";
  }
}

function startThrew(error: unknown): LedTestPatternResult {
  return {
    active: false,
    previewOnly: false,
    status: {
      code: LED_TEST_STATUS.PATTERN_RUNTIME_ERROR,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function useColorOrderIdentify({
  start = startLedTestPattern,
  stop = stopLedTestPattern,
  save,
  onApplied,
  current,
}: ColorOrderIdentifyDeps): ColorOrderIdentify {
  const [state, setState] = useState<IdentifyState>({ step: "idle" });

  // Bumped by cancel and unmount so a start resolving afterwards cannot move a
  // flow that no longer exists.
  const generationRef = useRef(0);
  // Set by a start that reports itself active, cleared once a stop lands. A
  // stop with no test running restores no prior mode and turns the lights off,
  // so it is only ever sent while this is true.
  const probeLiveRef = useRef(false);
  const inFlightRef = useRef<Promise<LedTestPatternResult> | null>(null);

  const depsRef = useRef({ start, stop, save, onApplied, current });
  useEffect(() => {
    depsRef.current = { start, stop, save, onApplied, current };
  }, [start, stop, save, onApplied, current]);

  // Shared, because a cancel landing during apply's stop would otherwise send
  // a second stop after the first had already restored the mode.
  const stoppingRef = useRef<Promise<boolean> | null>(null);

  const stopProbe = useCallback((): Promise<boolean> => {
    if (stoppingRef.current) return stoppingRef.current;
    const stopping = (async () => {
      while (inFlightRef.current) await inFlightRef.current;
      if (!probeLiveRef.current) return true;
      let result: LedTestPatternResult;
      try {
        result = await depsRef.current.stop();
      } catch (error) {
        console.error("[LumaSync] colour-order probe stop threw:", error);
        return false;
      }
      if (result.status.code === LED_TEST_STATUS.PATTERN_RUNTIME_ERROR) {
        console.error("[LumaSync] colour-order probe stop failed:", result.status);
        return false;
      }
      probeLiveRef.current = false;
      return true;
    })().finally(() => {
      stoppingRef.current = null;
    });
    stoppingRef.current = stopping;
    return stopping;
  }, []);

  const runSlot = useCallback(
    async (slot: ProbeSlot, answers: ProbeColor[], generation: number) => {
      // What `stopProbe` waits on, so it settles only once `probeLiveRef`
      // reflects this start, and never rejects.
      const liveness = depsRef.current
        .start({
          pattern: { kind: "channelProbe", slot },
          brightness: PROBE_BRIGHTNESS,
          targets: ["usb"],
        })
        .catch((error: unknown) => {
          console.error("[LumaSync] colour-order probe start threw:", error);
          return startThrew(error);
        })
        .then((result) => {
          // A failed retune may leave the previous slot lit, so a start that
          // is not active never clears the flag.
          if (result.active) probeLiveRef.current = true;
          return result;
        });
      inFlightRef.current = liveness;
      const result = await liveness;
      if (inFlightRef.current === liveness) inFlightRef.current = null;
      if (generation !== generationRef.current) return;

      const failure = probeStartFailure(result);
      if (failure) {
        console.error("[LumaSync] colour-order probe did not reach the strip:", result.status);
        await stopProbe();
        if (generation !== generationRef.current) return;
        setState({ step: "failed", reason: failure });
        return;
      }
      setState({ step: "probe", slot, answers, pending: false, duplicate: null });
    },
    [stopProbe],
  );

  const begin = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setState({ step: "probe", slot: 0, answers: [], pending: true, duplicate: null });
    void runSlot(0, [], generation);
  }, [runSlot]);

  const answer = useCallback(
    (given: ProbeAnswer) => {
      if (state.step !== "probe" || state.pending) return;
      const generation = generationRef.current;

      if (given === "other") {
        setState({ ...state, pending: true });
        void (async () => {
          const stopped = await stopProbe();
          if (!stopped) console.error("[LumaSync] probe may still be lit after 'something else'");
          if (generation !== generationRef.current) return;
          setState({ step: "failed", reason: "other" });
        })();
        return;
      }

      if (state.answers.includes(given)) {
        setState({ ...state, duplicate: given });
        return;
      }

      const answers = [...state.answers, given];
      if (answers.length < 3) {
        const slot = answers.length as ProbeSlot;
        setState({ step: "probe", slot, answers, pending: true, duplicate: null });
        void runSlot(slot, answers, generation);
        return;
      }

      const order = colorOrderFromAnswers(answers);
      if (!order) {
        setState({ ...state, duplicate: given });
        return;
      }
      // The probe stays lit on the last slot until the user applies or cancels.
      setState({ step: "result", order, pending: false });
    },
    [runSlot, state, stopProbe],
  );

  const applyOrder = useCallback(
    async (order: LedColorOrder, previous: LedColorOrder, generation: number) => {
      // Order is load-bearing. Save first: stopping the test restores the prior
      // mode with its output stamps re-read from disk, so an unsaved order would
      // be restored as the old one. Stop before the retune: a retune dispatched
      // while the probe is lit lands on the test, not on the restored mode.
      try {
        await depsRef.current.save(order);
      } catch (error) {
        console.error("[LumaSync] saving ledColorOrder failed:", error);
        await stopProbe();
        if (generation !== generationRef.current) return;
        setState({ step: "failed", reason: "saveFailed" });
        return;
      }
      const stopped = await stopProbe();
      if (generation !== generationRef.current) return;
      if (!stopped) {
        setState({ step: "failed", reason: "stopFailed", order });
        return;
      }
      depsRef.current.onApplied(order);
      setState({ step: "verify", order, previous, pending: false });
    },
    [stopProbe],
  );

  const apply = useCallback(() => {
    const generation = generationRef.current;
    if (state.step === "result" && !state.pending) {
      setState({ ...state, pending: true });
      void applyOrder(state.order, depsRef.current.current, generation);
      return;
    }
    // Retry after the stop could not be confirmed; saving again is idempotent.
    if (state.step === "failed" && state.reason === "stopFailed" && state.order) {
      const order = state.order;
      setState({ step: "result", order, pending: true });
      void applyOrder(order, depsRef.current.current, generation);
    }
  }, [applyOrder, state]);

  const keep = useCallback(() => {
    if (state.step !== "verify" || state.pending) return;
    setState({ step: "idle" });
  }, [state]);

  const undo = useCallback(() => {
    if (state.step !== "verify" || state.pending) return;
    const { previous } = state;
    const generation = generationRef.current;
    setState({ ...state, pending: true });
    void (async () => {
      try {
        await depsRef.current.save(previous);
      } catch (error) {
        console.error("[LumaSync] restoring the previous ledColorOrder failed:", error);
        if (generation !== generationRef.current) return;
        setState({ step: "failed", reason: "saveFailed" });
        return;
      }
      depsRef.current.onApplied(previous);
      if (generation !== generationRef.current) return;
      setState({ step: "idle" });
    })();
  }, [state]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    setState({ step: "idle" });
    void stopProbe().then((stopped) => {
      if (!stopped) console.error("[LumaSync] colour-order probe may still be lit after cancel");
    });
  }, [stopProbe]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      void stopProbe().then((stopped) => {
        if (!stopped) console.error("[LumaSync] colour-order probe may still be lit after unmount");
      });
    },
    [stopProbe],
  );

  return { state, begin, answer, apply, keep, undo, cancel };
}
