import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../model/contracts";
import {
  createCalibrationEditorState,
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
