import { describe, expect, it } from "vitest";

import { cx } from "../cx";

describe("cx", () => {
  it("joins the truthy entries with single spaces", () => {
    expect(cx("lm-row", "is-nested")).toBe("lm-row is-nested");
  });

  it("drops empty strings and falsy entries, so no stray spaces appear", () => {
    expect(cx("lm-row", "", false, null, undefined, "is-on")).toBe("lm-row is-on");
    expect(cx("", false)).toBe("");
  });
});
