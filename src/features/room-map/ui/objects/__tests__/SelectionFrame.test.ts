import { describe, expect, it } from "vitest";

import { handleCursor, rotationToward } from "../SelectionFrame";

describe("handleCursor", () => {
  it("turns with the piece", () => {
    expect(handleCursor("e", 0)).toBe("ew-resize");
    expect(handleCursor("e", 90)).toBe("ns-resize");
    expect(handleCursor("n", 45)).toBe("nesw-resize");
    expect(handleCursor("ne", 45)).toBe("ew-resize");
  });
});

describe("rotationToward", () => {
  it("reads up as unturned and steps by 15° unless free", () => {
    expect(rotationToward(0, -10, false)).toBe(0);
    expect(rotationToward(10, 0, false)).toBe(90);
    expect(rotationToward(10, -1, false)).toBe(90);
    expect(rotationToward(10, -1, true)).toBe(84);
  });
});
