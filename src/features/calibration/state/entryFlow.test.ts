import { describe, expect, it, vi } from "vitest";

import type { LedCalibrationConfig } from "../model/contracts";
import {
  deriveCalibrationOverlayEntry,
  startCalibrationFromSettings,
} from "./entryFlow";
import {
  createCalibrationEditorState,
  requestEditorClose,
  updateEditorConfig,
} from "./calibrationEditorState";
import {
  MODE_GUARD_REASONS,
  resolveLedModeEnableAttempt,
} from "../../mode/state/modeGuard";
import {
  getGeneralModeLockState,
  triggerCalibrationFromLock,
} from "../../settings/sections/GeneralSection";

const EXISTING_CALIBRATION: LedCalibrationConfig = {
  templateId: "monitor-27-16-9",
  counts: {
    top: 36,
    left: 22,
    right: 22,
    bottomLeft: 17,
    bottomRight: 17,
  },
  bottomGapPx: 140,
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 114,
};

describe("calibration entry flow", () => {
  it("auto-opens wizard overlay on first connected run when calibration is missing", () => {
    const entry = deriveCalibrationOverlayEntry({
      hasConnectedDevice: true,
      savedCalibration: undefined,
    });

    expect(entry.open).toBe(true);
    expect(entry.step).toBe("template");
    expect(entry.reason).toBe("first-connection");
  });

  it("uses same overlay flow for settings edit and starts from editor with saved values", () => {
    const entry = startCalibrationFromSettings(EXISTING_CALIBRATION);

    expect(entry.open).toBe(true);
    expect(entry.step).toBe("editor");
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

  it("open calibration CTA state is visible when mode is locked", () => {
    const lockState = getGeneralModeLockState(MODE_GUARD_REASONS.CALIBRATION_REQUIRED);
    const openCalibrationOverlay = vi.fn();

    triggerCalibrationFromLock(lockState, openCalibrationOverlay);

    expect(lockState.showReason).toBe(true);
    expect(lockState.showOpenCalibrationAction).toBe(true);
    expect(openCalibrationOverlay).toHaveBeenCalledOnce();
  });
});
