import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { setCount } from "../../model/ledLayout";
import { createCalibrationEditorState, isSameCalibrationLayout } from "../calibrationEditorState";
import { commitLayout, draftOf, layoutUiFrom, startOf } from "../layoutEdit";

const SAVED: LedCalibrationConfig = {
  counts: { top: 50, right: 32, bottom: 50, left: 32 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  startLocalIndex: 10,
  direction: "cw",
  totalLeds: 164,
};

describe("commitLayout", () => {
  const state = createCalibrationEditorState(SAVED);
  const ui = layoutUiFrom(SAVED);

  it("a start picked on the same edge is unsaved and restarts the running test", () => {
    const next = commitLayout(state, ui, draftOf(state.current, ui), {
      kind: "set",
      start: { led: { edge: "top", k: 11 }, direction: "cw" },
    });
    expect(next.state.current).toMatchObject({ startAnchor: "top-start", startLocalIndex: 11 });
    expect(next.state.isDirty).toBe(true);
    expect(isSameCalibrationLayout(state.current, next.state.current)).toBe(false);
  });

  it("writes an end back as the anchor alone", () => {
    const next = commitLayout(state, ui, draftOf(state.current, ui), {
      kind: "set",
      start: { led: { edge: "top", k: 49 }, direction: "cw" },
    });
    expect(next.state.current.startAnchor).toBe("top-end");
    expect(next.state.current).not.toHaveProperty("startLocalIndex");
  });

  it("keeps a mid-edge start where it was when the counts change", () => {
    const draft = setCount(draftOf(state.current, ui), "tb", 60, { width: 16, height: 9 });
    const next = commitLayout(state, ui, draft, { kind: "hold" });
    expect(startOf(next.state.current).led).toEqual({ edge: "top", k: 10 });
  });
});
