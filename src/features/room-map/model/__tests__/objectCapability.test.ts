import { describe, expect, it } from "vitest";

import { canDeleteObjectKind } from "../objectCapability";

describe("canDeleteObjectKind", () => {
  it("refuses Hue channels, which the backend has no delete path for", () => {
    expect(canDeleteObjectKind("hue")).toBe(false);
  });

  it("allows every kind deleteById actually handles", () => {
    for (const kind of ["tv", "furniture", "usb", "image"]) {
      expect(canDeleteObjectKind(kind)).toBe(true);
    }
  });

  it("refuses an unknown kind rather than offering a no-op", () => {
    expect(canDeleteObjectKind(undefined)).toBe(false);
    expect(canDeleteObjectKind("not-a-kind")).toBe(false);
  });
});
