import { describe, expect, it } from "vitest";

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
});
