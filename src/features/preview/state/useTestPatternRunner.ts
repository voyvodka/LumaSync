// useTestPatternRunner — serialised, throttled driver for `start_led_test_pattern`.
// Every call rebuilds the ambilight worker (apply_mode_change's fast path is off
// while a test is pending/active), so 20 Hz inputs must go through `refresh()`.

import { useCallback, useEffect, useRef } from "react";

import {
  LED_TEST_STATUS,
  type LedTestPattern,
  type LedTestPatternResult,
  type LedTestStatusCode,
  type TestPatternSpeed,
} from "../../../shared/contracts/preview";
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";
import { startLedTestPattern, stopLedTestPattern } from "../previewApi";

/**
 * Floor between two worker restarts driven by a continuous input. 250 ms keeps
 * a colour drag visibly live (~4 Hz) while cutting the raw 20 Hz commit rate
 * of `useSolidColorDraft` by 5x.
 */
export const TEST_PATTERN_REFRESH_MIN_INTERVAL_MS = 250;

/** Status codes that represent a genuine failure (PREVIEW_ONLY is a success). */
const ERROR_CODES: ReadonlySet<string> = new Set<LedTestStatusCode>([
  LED_TEST_STATUS.PATTERN_NO_CALIBRATION,
  LED_TEST_STATUS.PATTERN_INVALID_PARAMS,
  LED_TEST_STATUS.PATTERN_RUNTIME_ERROR,
]);

export function isTestPatternErrorCode(code: string): boolean {
  return ERROR_CODES.has(code);
}

export interface TestPatternRunRequest {
  pattern: LedTestPattern;
  brightness: number;
  speed: TestPatternSpeed;
  targets?: HueRuntimeTarget[];
}

export interface UseTestPatternRunnerOptions {
  /** Called after every resolved start, with the request that produced it. */
  onResult: (result: LedTestPatternResult, request: TestPatternRunRequest) => void;
  /** Injectable for tests. */
  start?: typeof startLedTestPattern;
  /** Injectable for tests. */
  stop?: typeof stopLedTestPattern;
  minIntervalMs?: number;
}

export interface TestPatternRunner {
  /** Discrete gesture — dispatch now, clearing any error latch. */
  apply: (request: TestPatternRunRequest) => void;
  /** Continuous input — throttled, suppressed while latched by an error. */
  refresh: (request: TestPatternRunRequest) => void;
  /** Drop pending work without touching the backend (mode-strip takeover). */
  cancel: () => void;
  /** Cancel pending work and stop the running test. */
  stop: () => Promise<void>;
  /** Resolves once no start is in flight — await before issuing a mode command. */
  settled: () => Promise<void>;
}

export function useTestPatternRunner({
  onResult,
  start = startLedTestPattern,
  stop = stopLedTestPattern,
  minIntervalMs = TEST_PATTERN_REFRESH_MIN_INTERVAL_MS,
}: UseTestPatternRunnerOptions): TestPatternRunner {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<TestPatternRunRequest | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastStartAtRef = useRef(0);
  const blockedRef = useRef(false);
  // Bumped by `cancel()` so a start that resolves after a takeover cannot write
  // stale run feedback over the new state.
  const generationRef = useRef(0);

  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // `dispatch` and `schedule` are mutually recursive (a completed start
  // re-schedules whatever arrived while it was in flight), so the pair is
  // wired through refs rather than a circular useCallback dependency.
  const scheduleRef = useRef<() => void>(() => {});

  const dispatch = useCallback(() => {
    const request = pendingRef.current;
    if (!request || inFlightRef.current) return;
    pendingRef.current = null;
    lastStartAtRef.current = Date.now();
    const generation = generationRef.current;

    inFlightRef.current = (async () => {
      let result: LedTestPatternResult;
      try {
        result = await start({
          pattern: request.pattern,
          brightness: request.brightness,
          speed: request.speed,
          targets: request.targets,
        });
      } catch (error) {
        // `startLedTestPattern` degrades transport rejections to a coded
        // result, so this arm means an unexpected throw. Log it and synthesise
        // the same coded failure rather than wedging `inFlightRef` forever.
        console.error("[LumaSync] useTestPatternRunner start threw:", error);
        result = {
          active: false,
          previewOnly: false,
          status: {
            code: LED_TEST_STATUS.PATTERN_RUNTIME_ERROR,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        inFlightRef.current = null;
      }

      if (generation !== generationRef.current) return;

      blockedRef.current = isTestPatternErrorCode(result.status.code);
      onResultRef.current(result, request);

      if (blockedRef.current) {
        pendingRef.current = null;
        clearTimer();
        return;
      }
      if (pendingRef.current) scheduleRef.current();
    })();
  }, [clearTimer, start]);

  const schedule = useCallback(() => {
    if (inFlightRef.current) return;
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastStartAtRef.current));
    if (waitMs === 0) {
      clearTimer();
      dispatch();
      return;
    }
    // Keep an already-armed timer: it flushes `pendingRef`, which always holds
    // the newest request. Restarting it would starve a continuous drag.
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dispatch();
    }, waitMs);
  }, [clearTimer, dispatch, minIntervalMs]);

  useEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

  const apply = useCallback(
    (request: TestPatternRunRequest) => {
      blockedRef.current = false;
      pendingRef.current = request;
      clearTimer();
      // An in-flight start dispatches the pending request on completion.
      if (!inFlightRef.current) dispatch();
    },
    [clearTimer, dispatch],
  );

  const refresh = useCallback(
    (request: TestPatternRunRequest) => {
      if (blockedRef.current) return;
      pendingRef.current = request;
      schedule();
    },
    [schedule],
  );

  const cancel = useCallback(() => {
    generationRef.current += 1;
    pendingRef.current = null;
    blockedRef.current = false;
    clearTimer();
  }, [clearTimer]);

  const settled = useCallback(async () => {
    // A start scheduled behind another can leave a second promise; drain them.
    while (inFlightRef.current) await inFlightRef.current;
  }, []);

  const stopRun = useCallback(async () => {
    cancel();
    await settled();
    await stop();
  }, [cancel, settled, stop]);

  return { apply, refresh, cancel, stop: stopRun, settled };
}
