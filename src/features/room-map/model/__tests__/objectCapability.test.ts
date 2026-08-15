import { describe, expect, it } from "vitest";

import {
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  TV_ANCHOR_OBJECT_ID,
  usbStripObjectId,
} from "../objectId";
import { canDeleteObjectId, canDeleteObjectKind } from "../objectCapability";

describe("canDeleteObjectKind", () => {
  it("refuses Hue channels, which the backend has no delete path for", () => {
    expect(canDeleteObjectKind("hue")).toBe(false);
  });

  it("allows every kind deleteById actually handles", () => {
    for (const kind of ["tv", "furniture", "usb", "image"]) {
      expect(canDeleteObjectKind(kind)).toBe(true);
    }
  });

  it("refuses an unparseable id rather than offering a no-op", () => {
    expect(canDeleteObjectKind(undefined)).toBe(false);
    expect(canDeleteObjectId("not-an-object-id")).toBe(false);
  });
});

describe("canDeleteObjectId", () => {
  it("agrees with the kind rule for real ids", () => {
    expect(canDeleteObjectId(hueChannelObjectId(3))).toBe(false);
    expect(canDeleteObjectId(TV_ANCHOR_OBJECT_ID)).toBe(true);
    expect(canDeleteObjectId(furnitureObjectId("f1"))).toBe(true);
    expect(canDeleteObjectId(usbStripObjectId("s1"))).toBe(true);
    expect(canDeleteObjectId(imageLayerObjectId("i1"))).toBe(true);
  });
});
