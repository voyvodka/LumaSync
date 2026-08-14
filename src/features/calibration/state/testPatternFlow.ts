import { LED_TEST_STATUS, type LedTestPatternResult, type LedTestStatusCode } from "@/shared/contracts/preview";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import { acquireHueForTest, releaseHueAfterTest } from "@/features/hue/state/hueTestLease";
import { shellStore } from "@/features/persistence/shellStore";

import { startLedTestPattern, stopLedTestPattern } from "../../preview/previewApi";
import type { LedCalibrationConfig } from "../model/contracts";

export type TestPatternMode = "sending" | "preview-only";

export interface TestPatternSnapshot {
  isEnabled: boolean;
  mode: TestPatternMode;
  /** Coded outcome of the last start/stop, so the page can explain a refusal
   * instead of showing an enabled test that never reached a strip. */
  lastStatus: LedTestStatusCode | null;
}

interface CreateTestPatternFlowDeps {
  startPattern: () => Promise<LedTestPatternResult>;
  stopPattern: () => Promise<LedTestPatternResult>;
  onConfigChange?: (config: LedCalibrationConfig) => void;
}

export interface TestPatternFlow {
  getSnapshot: () => TestPatternSnapshot;
  setConfig: (config: LedCalibrationConfig) => void;
  toggle: (enabled: boolean) => Promise<TestPatternSnapshot>;
  dispose: () => Promise<void>;
}

const IDLE: TestPatternSnapshot = { isEnabled: false, mode: "preview-only", lastStatus: null };

/** Brightness the LED Setup chase runs at. Bright enough to read the ordering
 * across a room, short of the eye-watering full scale. */
const TEST_BRIGHTNESS = 0.5;

export function createTestPatternFlow(deps: CreateTestPatternFlowDeps): TestPatternFlow {
  let snapshot: TestPatternSnapshot = IDLE;

  return {
    getSnapshot: () => snapshot,
    setConfig: (config) => {
      deps.onConfigChange?.(config);
    },
    toggle: async (enabled) => {
      if (!enabled) {
        const result = await deps.stopPattern();
        snapshot = { ...IDLE, lastStatus: result.status.code };
        return snapshot;
      }

      const result = await deps.startPattern();
      snapshot = {
        // The backend owns this verdict. Reporting "sending" from a cached
        // connection flag is exactly how the previous no-op stayed hidden.
        isEnabled: result.active,
        mode: result.previewOnly ? "preview-only" : "sending",
        lastStatus: result.status.code,
      };
      return snapshot;
    },
    dispose: async () => {
      if (snapshot.isEnabled) {
        await deps.stopPattern();
      }
      snapshot = IDLE;
    },
  };
}

/** True when a start refused outright — nothing is running and the user needs
 * to be told why, as opposed to a preview-only run that is merely limited. */
export function isTestPatternFailure(status: LedTestStatusCode | null): boolean {
  return (
    status === LED_TEST_STATUS.PATTERN_NO_CALIBRATION ||
    status === LED_TEST_STATUS.PATTERN_INVALID_PARAMS ||
    status === LED_TEST_STATUS.PATTERN_RUNTIME_ERROR
  );
}

/** The outputs the user last lit. Hardcoding `["usb"]` here meant a Hue-only
 * setup could never get anything but a preview out of LED Setup's test. */
async function resolveTestTargets(): Promise<HueRuntimeTarget[]> {
  try {
    const state = await shellStore.load();
    if (state.lastOutputTargets && state.lastOutputTargets.length > 0) {
      return [...state.lastOutputTargets];
    }
  } catch (error) {
    console.error("[LumaSync] testPatternFlow could not read the output targets:", error);
  }
  return ["usb"];
}

export function createDefaultTestPatternFlow(initialConfig?: LedCalibrationConfig): TestPatternFlow {
  let currentConfig: LedCalibrationConfig | undefined = initialConfig;

  return createTestPatternFlow({
    onConfigChange: (config) => {
      currentConfig = config;
    },
    // A chase walks the strip in calibrated order, which is the thing LED
    // Setup exists to verify. `ledCalibration` carries the *unsaved* editor
    // layout so the test matches what is on screen, not the last save.
    startPattern: async () => {
      const targets = await resolveTestTargets();
      await acquireHueForTest(targets);
      const result = await startLedTestPattern({
        pattern: { kind: "chase", r: 255, g: 255, b: 255 },
        brightness: TEST_BRIGHTNESS,
        speed: "med",
        targets,
        ledCalibration: currentConfig,
      });
      // A refused start leaves nothing for `dispose` to stop, so the stream we
      // just opened would stay up with no test behind it.
      if (!result.active) await releaseHueAfterTest();
      return result;
    },
    stopPattern: async () => {
      try {
        return await stopLedTestPattern();
      } finally {
        await releaseHueAfterTest();
      }
    },
  });
}
