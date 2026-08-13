import { describe, it, expect } from "vitest";
import {
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  parseObjectId,
  TV_ANCHOR_OBJECT_ID,
  usbStripObjectId,
} from "../objectId";

describe("format helpers", () => {
  it("produce the wire format the dock and canvas already agree on", () => {
    expect(furnitureObjectId("f1")).toBe("furniture-f1");
    expect(usbStripObjectId("s1")).toBe("usb-s1");
    expect(hueChannelObjectId(3)).toBe("hue-3");
    expect(imageLayerObjectId("i1")).toBe("img-i1");
    expect(TV_ANCHOR_OBJECT_ID).toBe("tv");
  });
});

describe("parseObjectId", () => {
  it("round-trips every kind", () => {
    expect(parseObjectId(furnitureObjectId("f1"))).toEqual({
      kind: "furniture",
      furnitureId: "f1",
    });
    expect(parseObjectId(usbStripObjectId("s1"))).toEqual({ kind: "usb", stripId: "s1" });
    expect(parseObjectId(hueChannelObjectId(3))).toEqual({ kind: "hue", channelIndex: 3 });
    expect(parseObjectId(imageLayerObjectId("i1"))).toEqual({ kind: "image", layerId: "i1" });
    expect(parseObjectId(TV_ANCHOR_OBJECT_ID)).toEqual({ kind: "tv" });
  });

  it("returns null for an unprefixed id, so callers fall through as before", () => {
    expect(parseObjectId("")).toBeNull();
    expect(parseObjectId("zone-a")).toBeNull();
    expect(parseObjectId("3f2b1c0a-dead-4beef-8888-0123456789ab")).toBeNull();
  });

  it("matches `tv` exactly rather than as a prefix", () => {
    expect(parseObjectId("tv")).toEqual({ kind: "tv" });
    expect(parseObjectId("tvx")).toBeNull();
  });

  it("strips only the leading prefix when the payload repeats it", () => {
    // TemplateSelector ships strips whose stripId is literally "usb-tv".
    expect(parseObjectId(usbStripObjectId("usb-tv"))).toEqual({
      kind: "usb",
      stripId: "usb-tv",
    });
    expect(parseObjectId(furnitureObjectId("furniture-x"))).toEqual({
      kind: "furniture",
      furnitureId: "furniture-x",
    });
  });

  it("keeps a malformed channel index as NaN instead of rejecting the id", () => {
    const parsed = parseObjectId("hue-abc");
    expect(parsed?.kind).toBe("hue");
    expect(Number.isNaN((parsed as { channelIndex: number }).channelIndex)).toBe(true);
  });

  it("parses a leading integer out of a mixed channel suffix, as parseInt always did", () => {
    expect(parseObjectId("hue-12x")).toEqual({ kind: "hue", channelIndex: 12 });
  });

  it("accepts an empty payload rather than treating the id as unrecognised", () => {
    expect(parseObjectId("furniture-")).toEqual({ kind: "furniture", furnitureId: "" });
    expect(parseObjectId("img-")).toEqual({ kind: "image", layerId: "" });
  });

  it("behaves identically to the prefix-replace it replaced, for every guarded prefix", () => {
    // The old call sites all ran `id.replace(prefix, "")` behind a
    // `startsWith(prefix)` guard, which makes replace and slice equivalent.
    for (const [prefix, id] of [
      ["furniture-", "furniture-a-furniture-b"],
      ["usb-", "usb-usb-tv"],
      ["img-", "img-img-1"],
    ] as const) {
      const parsed = parseObjectId(id) as Record<string, string>;
      const payload = Object.values(parsed).find((v) => v !== parsed.kind);
      expect(payload).toBe(id.replace(prefix, ""));
    }
  });
});
