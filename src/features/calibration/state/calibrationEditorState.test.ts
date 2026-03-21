import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../model/contracts";
import {
  createCalibrationEditorState,
  requestEditorClose,
  saveEditorCalibration,
  updateEditorConfig,
} from "./calibrationEditorState";

const BASELINE: LedCalibrationConfig = {
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

describe("calibrationEditorState", () => {
  it("uses current saved model as baseline and starts clean", () => {
    const state = createCalibrationEditorState(BASELINE);

    expect(state.baseline).toEqual(BASELINE);
    expect(state.current).toEqual(BASELINE);
    expect(state.isDirty).toBe(false);
  });

  it("tracks dirty state and clears it when values are restored", () => {
    const dirtyState = updateEditorConfig(createCalibrationEditorState(BASELINE), {
      counts: {
        top: 40,
      },
      direction: "ccw",
      startAnchor: "top-end",
      templateId: "monitor-34-ultrawide",
    });

    expect(dirtyState.isDirty).toBe(true);

    const restored = updateEditorConfig(dirtyState, {
      counts: {
        top: BASELINE.counts.top,
      },
      direction: BASELINE.direction,
      startAnchor: BASELINE.startAnchor,
      templateId: BASELINE.templateId,
    });

    expect(restored.isDirty).toBe(false);
  });

  it("updates baseline after save and requires confirm only when dirty", () => {
    const dirtyState = updateEditorConfig(createCalibrationEditorState(BASELINE), {
      counts: {
        right: 24,
      },
    });

    const dirtyCloseAttempt = requestEditorClose(dirtyState);
    expect(dirtyCloseAttempt.shouldClose).toBe(false);
    expect(dirtyCloseAttempt.confirmDiscard).toBe(true);

    const saved = saveEditorCalibration(dirtyState);
    expect(saved.baseline.counts.right).toBe(24);
    expect(saved.isDirty).toBe(false);

    const cleanCloseAttempt = requestEditorClose(saved);
    expect(cleanCloseAttempt.shouldClose).toBe(true);
    expect(cleanCloseAttempt.confirmDiscard).toBe(false);
  });
});
