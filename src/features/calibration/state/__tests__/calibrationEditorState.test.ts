import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import {
  autofillEditorConfig,
  createCalibrationEditorState,
  isSameCalibrationLayout,
  requestEditorClose,
  saveEditorCalibration,
  updateEditorConfig,
} from "../calibrationEditorState";

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

  it("auto-heals start anchor when its edge drops to zero", () => {
    // anchor is `top-start` — if we zero out the top edge, anchor should
    // migrate to the next non-zero edge's start so the strip still has a head.
    const state = createCalibrationEditorState(BASELINE);
    const zeroedTop = updateEditorConfig(state, { counts: { top: 0 } });

    expect(zeroedTop.current.counts.top).toBe(0);
    expect(zeroedTop.current.startAnchor).not.toBe("top-start");
    expect(zeroedTop.current.startAnchor.startsWith("top")).toBe(false);
  });

  it("clamps bottom stand gap to bottom count and collapses bottom-gap anchors", () => {
    const gapped: LedCalibrationConfig = {
      ...BASELINE,
      bottomMissing: 4,
      startAnchor: "bottom-gap-right",
    };
    const state = createCalibrationEditorState(gapped);
    expect(state.current.bottomMissing).toBe(4);
    expect(state.current.startAnchor).toBe("bottom-gap-right");

    const zeroGap = updateEditorConfig(state, { bottomMissing: 0 });
    expect(zeroGap.current.bottomMissing).toBe(0);
    expect(zeroGap.current.startAnchor).toBe("bottom-start");

    const overflow = updateEditorConfig(state, { bottomMissing: 9999 });
    expect(overflow.current.bottomMissing).toBe(BASELINE.counts.bottom);
  });

  it("accepts a partial-edge configuration (only top strip)", () => {
    const topOnly: LedCalibrationConfig = {
      ...BASELINE,
      counts: { top: 30, right: 0, bottom: 0, left: 0 },
      bottomMissing: 0,
      startAnchor: "top-start",
      totalLeds: 30,
    };
    const state = createCalibrationEditorState(topOnly);
    expect(state.current.counts).toEqual({ top: 30, right: 0, bottom: 0, left: 0 });
    expect(state.current.startAnchor).toBe("top-start");
    expect(state.current.totalLeds).toBe(30);
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

describe("calibrationEditorState — automatic fills and handed-over counts", () => {
  const ZERO: LedCalibrationConfig = {
    ...BASELINE,
    templateId: undefined,
    counts: { top: 0, right: 0, bottom: 0, left: 0 },
    bottomMissing: 0,
    totalLeds: 0,
  };
  const DEFAULTS = { top: 30, right: 17, bottom: 30, left: 17 };

  it("treats a display-derived fill on an untouched draft as the baseline, not an edit", () => {
    const filled = autofillEditorConfig(createCalibrationEditorState(ZERO), { counts: DEFAULTS });
    expect(filled.current.counts).toEqual(DEFAULTS);
    expect(filled.baseline.counts).toEqual(DEFAULTS);
    expect(filled.isDirty).toBe(false);
    expect(requestEditorClose(filled).shouldClose).toBe(true);
  });

  it("lands the fill on the draft alone once the user has edited", () => {
    const edited = updateEditorConfig(createCalibrationEditorState(ZERO), { direction: "ccw" });
    const filled = autofillEditorConfig(edited, { counts: DEFAULTS });
    expect(filled.baseline.counts).toEqual(ZERO.counts);
    expect(filled.isDirty).toBe(true);
  });

  it("opens counts handed over from the room map as an unsaved draft over the saved layout", () => {
    const counts = { top: 40, right: 20, bottom: 40, left: 20 };
    const state = createCalibrationEditorState(BASELINE, counts);
    expect(state.baseline).toEqual(BASELINE);
    expect(state.current.counts).toEqual(counts);
    expect(state.current.totalLeds).toBe(120);
    expect(state.isDirty).toBe(true);
    expect(requestEditorClose(state).confirmDiscard).toBe(true);
  });

  it("compares layouts by what normalisation keeps", () => {
    expect(isSameCalibrationLayout(BASELINE, { ...BASELINE })).toBe(true);
    expect(isSameCalibrationLayout(BASELINE, { ...BASELINE, direction: "ccw" })).toBe(false);
  });
});
