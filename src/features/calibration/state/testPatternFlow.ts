import {
  startCalibrationTestPattern,
  stopCalibrationTestPattern,
} from "../calibrationApi";
import type { LedCalibrationConfig } from "../model/contracts";
import { buildLedSequence, resolveLedSequenceItem } from "../model/indexMapping";

export type TestPatternMode = "sending" | "preview-only";

export interface TestPatternSnapshot {
  isEnabled: boolean;
  mode: TestPatternMode;
  markerIndex: number;
  totalLeds: number;
  isBlockingSave: boolean;
}

interface TestPatternConnectionStatus {
  connected: boolean;
}

interface CreateTestPatternFlowDeps {
  getConnectionStatus: () => Promise<TestPatternConnectionStatus>;
  startPhysicalPattern: (markerIndex: number) => Promise<void>;
  stopPhysicalPattern: () => Promise<void>;
  initialConfig?: LedCalibrationConfig;
  onConfigChange?: (config: LedCalibrationConfig) => void;
  now?: () => number;
  scheduleFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frameId: number) => void;
}

const MARKER_ADVANCE_MS = 120;

export interface TestPatternFlow {
  getSnapshot: () => TestPatternSnapshot;
  setTotalLeds: (totalLeds: number) => TestPatternSnapshot;
  setConfig: (config: LedCalibrationConfig) => void;
  toggle: (enabled: boolean) => Promise<TestPatternSnapshot>;
  dispose: () => Promise<void>;
}

function nextMarkerIndex(current: number, totalLeds: number): number {
  if (totalLeds <= 0) {
    return 0;
  }

  return (current + 1) % totalLeds;
}

export function createTestPatternFlow(deps: CreateTestPatternFlowDeps): TestPatternFlow {
  const now = deps.now ?? (() => Date.now());
  const scheduleFrame =
    deps.scheduleFrame ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback));
  const cancelFrame =
    deps.cancelFrame ?? ((frameId: number) => window.cancelAnimationFrame(frameId));

  let snapshot: TestPatternSnapshot = {
    isEnabled: false,
    mode: "preview-only",
    markerIndex: 0,
    totalLeds: 24,
    isBlockingSave: false,
  };

  let frameId: number | null = null;
  let lastMarkerAt = now();
  const stopAnimation = () => {
    if (frameId === null) {
      return;
    }

    cancelFrame(frameId);
    frameId = null;
  };

  const startAnimation = () => {
    stopAnimation();
    lastMarkerAt = now();

    const tick: FrameRequestCallback = (timestamp) => {
      if (!snapshot.isEnabled) {
        frameId = null;
        return;
      }

      if (timestamp - lastMarkerAt >= MARKER_ADVANCE_MS) {
        snapshot = {
          ...snapshot,
          markerIndex: nextMarkerIndex(snapshot.markerIndex, snapshot.totalLeds),
        };
        lastMarkerAt = timestamp;
      }

      frameId = scheduleFrame(tick);
    };

    frameId = scheduleFrame(tick);
  };

  const stopPhysical = async () => {
    await deps.stopPhysicalPattern();
  };

  return {
    getSnapshot: () => snapshot,
    setTotalLeds: (totalLeds) => {
      const normalizedTotal = Number.isFinite(totalLeds) ? Math.max(1, Math.floor(totalLeds)) : 1;
      snapshot = {
        ...snapshot,
        totalLeds: normalizedTotal,
        markerIndex: snapshot.markerIndex % normalizedTotal,
      };
      return snapshot;
    },
    setConfig: (config) => {
      deps.onConfigChange?.(config);
    },
    toggle: async (enabled) => {
      if (enabled) {
        snapshot = {
          ...snapshot,
          isEnabled: true,
          mode: "preview-only",
          markerIndex: 0,
          isBlockingSave: false,
        };
        startAnimation();

        try {
          const status = await deps.getConnectionStatus();
          if (status.connected) {
            await deps.startPhysicalPattern(snapshot.markerIndex);
            snapshot = {
              ...snapshot,
              mode: "sending",
            };
          }
        } catch (error) {
          console.warn(
            "[LumaSync] Test pattern hardware path failed, continuing preview-only:",
            error,
          );
          snapshot = {
            ...snapshot,
            mode: "preview-only",
          };
        }

        return snapshot;
      }

      stopAnimation();
      await stopPhysical();
      snapshot = {
        ...snapshot,
        isEnabled: false,
        mode: "preview-only",
        markerIndex: 0,
        isBlockingSave: false,
      };
      return snapshot;
    },
    dispose: async () => {
      stopAnimation();
      if (snapshot.isEnabled) {
        await stopPhysical();
      }
      snapshot = {
        ...snapshot,
        isEnabled: false,
        mode: "preview-only",
        markerIndex: 0,
        isBlockingSave: false,
      };
    },
  };
}

export function createDefaultTestPatternFlow(
  getConnectionStatus: () => Promise<TestPatternConnectionStatus>,
  initialConfig?: LedCalibrationConfig,
): TestPatternFlow {
  let currentConfig: LedCalibrationConfig | null = initialConfig ?? null;

  const resolvePhysicalIndex = (markerIndex: number) => {
    const fallbackIndex = Math.max(0, Math.floor(markerIndex));

    if (!currentConfig) {
      return fallbackIndex;
    }

    const sequence = buildLedSequence(currentConfig);
    return resolveLedSequenceItem(sequence, markerIndex)?.index ?? fallbackIndex;
  };

  return createTestPatternFlow({
    getConnectionStatus,
    initialConfig,
    onConfigChange: (config) => {
      currentConfig = config;
    },
    startPhysicalPattern: async (markerIndex) => {
      await startCalibrationTestPattern({
        ledIndexes: [resolvePhysicalIndex(markerIndex)],
        frameMs: MARKER_ADVANCE_MS,
        brightness: 64,
      });
    },
    stopPhysicalPattern: async () => {
      await stopCalibrationTestPattern();
    },
  });
}
