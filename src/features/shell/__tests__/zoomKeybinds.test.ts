import { describe, expect, it } from "vitest";

import { stepUiZoom } from "../useUiZoom";
import { zoomActionFor } from "../zoomKeybinds";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("zoom keys", () => {
  it("reads the printed key, so + and - work on any layout, Shift included", () => {
    expect(zoomActionFor(key({ key: "=", metaKey: true }), "macos")).toBe("in");
    expect(zoomActionFor(key({ key: "+", metaKey: true, shiftKey: true }), "macos")).toBe("in");
    // TR-Q: "-" is printed by the key whose code is Equal.
    expect(zoomActionFor(key({ key: "-", code: "Equal", metaKey: true }), "macos")).toBe("out");
    expect(zoomActionFor(key({ key: "0", ctrlKey: true }), "default")).toBe("reset");
  });

  it("takes only the platform's own modifier, and never with Alt", () => {
    expect(zoomActionFor(key({ key: "=", ctrlKey: true }), "macos")).toBeNull();
    expect(zoomActionFor(key({ key: "=", metaKey: true }), "default")).toBeNull();
    expect(zoomActionFor(key({ key: "0", metaKey: true, altKey: true }), "macos")).toBeNull();
    expect(zoomActionFor(key({ key: "1", metaKey: true }), "macos")).toBeNull();
  });

  it("steps through the sizes and stops at either end", () => {
    expect(stepUiZoom(100, "in")).toBe(110);
    expect(stepUiZoom(125, "in")).toBe(125);
    expect(stepUiZoom(100, "out")).toBe(90);
    expect(stepUiZoom(90, "out")).toBe(90);
    expect(stepUiZoom(125, "reset")).toBe(100);
  });
});
