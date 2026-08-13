import { describe, it, expect } from "vitest";
import { deriveHueAreaState } from "../hueAreaState";

describe("deriveHueAreaState", () => {
  it("reports not-configured with no orphan when nothing has ever been paired", () => {
    expect(deriveHueAreaState(false, null)).toEqual({
      kind: "not-configured",
      orphanedAreaId: false,
    });
    expect(deriveHueAreaState(false, undefined)).toEqual({
      kind: "not-configured",
      orphanedAreaId: false,
    });
  });

  it("flags an orphaned area id when the id outlived the bridge credential", () => {
    expect(deriveHueAreaState(false, "area-7")).toEqual({
      kind: "not-configured",
      orphanedAreaId: true,
    });
  });

  it("treats an empty-string area id as absent rather than orphaned", () => {
    expect(deriveHueAreaState(false, "")).toEqual({
      kind: "not-configured",
      orphanedAreaId: false,
    });
  });

  it("reports no-area once a bridge is paired but no area is picked", () => {
    expect(deriveHueAreaState(true, null)).toEqual({ kind: "no-area", orphanedAreaId: false });
    expect(deriveHueAreaState(true, "")).toEqual({ kind: "no-area", orphanedAreaId: false });
  });

  it("reports ready only when both a bridge and an area are on file", () => {
    expect(deriveHueAreaState(true, "area-7")).toEqual({ kind: "ready", orphanedAreaId: false });
  });

  it("never marks a configured bridge as orphaned", () => {
    for (const areaId of [null, undefined, "", "area-7"]) {
      expect(deriveHueAreaState(true, areaId).orphanedAreaId).toBe(false);
    }
  });
});
