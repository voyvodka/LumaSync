import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import {
  deriveCalibrationOverlayEntry,
  shouldPromptLedSetupOnConnection,
  startCalibrationFromSettings,
} from "../entryFlow";
import {
  createCalibrationEditorState,
  requestEditorClose,
  updateEditorConfig,
} from "../calibrationEditorState";
import {
  MODE_GUARD_REASONS,
  resolveLedModeEnableAttempt,
} from "@/features/mode/state/modeGuard";

const EXISTING_CALIBRATION: LedCalibrationConfig = {
  templateId: "monitor-27-16-9",
  counts: {
    top: 36,
    right: 22,
    bottom: 34,
    left: 22,
  },
  bottomMissing: 2,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 114,
};

describe("calibration entry flow", () => {
  it("prompts on first connection when calibration is missing", () => {
    const firstConnect = shouldPromptLedSetupOnConnection({
      connected: true,
      wasConnected: false,
      hasCalibration: false,
      alreadyPrompted: false,
    });

    expect(firstConnect).toBe(true);
  });

  it("does not prompt when a calibration is saved", () => {
    const hasCalibration = shouldPromptLedSetupOnConnection({
      connected: true,
      wasConnected: false,
      hasCalibration: true,
      alreadyPrompted: false,
    });

    expect(hasCalibration).toBe(false);
  });

  it("prompts on the first connection transition only and ignores rerender", () => {
    const firstTransition = shouldPromptLedSetupOnConnection({
      connected: true,
      wasConnected: false,
      hasCalibration: false,
      alreadyPrompted: false,
    });
    const rerenderWhileConnected = shouldPromptLedSetupOnConnection({
      connected: true,
      wasConnected: true,
      hasCalibration: false,
      alreadyPrompted: true,
    });

    expect(firstTransition).toBe(true);
    expect(rerenderWhileConnected).toBe(false);
  });

  it("auto-opens wizard overlay on first connected run when calibration is missing", () => {
    const entry = deriveCalibrationOverlayEntry({
      hasConnectedDevice: true,
      savedCalibration: undefined,
    });

    expect(entry.open).toBe(true);
    expect(entry.reason).toBe("first-connection");
  });

  it("uses same overlay flow for settings edit and starts with saved values", () => {
    const entry = startCalibrationFromSettings(EXISTING_CALIBRATION);

    expect(entry.open).toBe(true);
    expect(entry.initialConfig).toEqual(EXISTING_CALIBRATION);
  });

  it("requires close confirmation only when editor has unsaved changes", () => {
    const cleanEditor = createCalibrationEditorState(EXISTING_CALIBRATION);
    const cleanClose = requestEditorClose(cleanEditor);

    expect(cleanClose.shouldClose).toBe(true);
    expect(cleanClose.confirmDiscard).toBe(false);

    const dirtyEditor = updateEditorConfig(cleanEditor, {
      counts: {
        top: EXISTING_CALIBRATION.counts.top + 2,
      },
    });
    const dirtyClose = requestEditorClose(dirtyEditor);

    expect(dirtyClose.shouldClose).toBe(false);
    expect(dirtyClose.confirmDiscard).toBe(true);
  });

  it("CALIBRATION_REQUIRED gate keeps mode disabled when trying to enable", () => {
    const blocked = resolveLedModeEnableAttempt({
      currentEnabled: false,
      calibration: undefined,
    });

    expect(blocked.nextEnabled).toBe(false);
    expect(blocked.reason).toBe(MODE_GUARD_REASONS.CALIBRATION_REQUIRED);
    expect(blocked.shouldOpenCalibration).toBe(true);
  });
});
