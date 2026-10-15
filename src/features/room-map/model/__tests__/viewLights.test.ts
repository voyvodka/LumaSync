import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import { DEFAULT_ROOM_MAP, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { buildViewLights, resolveViewSelection, type ViewLightSources } from "../viewLights";

const t = ((key: string, opts?: Record<string, string>) =>
  opts ? `${key} ${JSON.stringify(opts)}` : key) as unknown as TFunction;

const zone: HueZone = {
  id: "z1",
  name: "Sofa",
  entertainmentAreaId: "a",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  channelIndices: [0],
  borderColor: "var(--lm-zone-4)",
};

const config: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  hueChannels: [
    { channelIndex: 2, channelId: 7, x: 0, y: 0, z: 0, label: "Shelf" },
    { channelIndex: 0, channelId: 3, x: 0, y: 0, z: 0, zoneId: "z1" },
    { channelIndex: 1, x: 0, y: 0, z: 0 },
  ],
  usbStrips: [{ stripId: "s1", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60 } as RoomMapConfig["usbStrips"][number]],
  furniture: [{ id: "sofa", type: "sofa", x: 1, y: 1, width: 2, height: 0.9 }],
  tvAnchor: { x: 1, y: 0, width: 1.2, height: 0.1 },
  zones: [zone],
};

const sources = (over: Partial<ViewLightSources> = {}): ViewLightSources => ({
  config,
  zones: [zone],
  areaChannels: [
    { index: 0, channelId: 3, lightIds: ["l-a", "l-b"], positionX: 0, positionY: 0, positionZ: null, lightCount: 2, autoRegion: "" },
  ] satisfies HueAreaChannelInfo[],
  liveChannelIds: new Set([3]),
  families: new Map([[0, "floorLamp"]]),
  ...over,
});

describe("buildViewLights", () => {
  it("lists Hue channels by index, then strips, then the screen", () => {
    expect(buildViewLights(sources(), t).map((l) => l.id)).toEqual(["hue-0", "hue-1", "hue-2", "usb-s1", "tv"]);
  });

  it("carries a channel's zone, fixture, light count and the lights to identify", () => {
    const [first] = buildViewLights(sources(), t);
    expect(first).toMatchObject({
      zone: { name: "Sofa", colour: "var(--lm-zone-4)" },
      family: "floorLamp",
      lightCount: 2,
      lightIds: ["l-a", "l-b"],
      ghost: false,
      unmatched: false,
    });
  });

  it("guesses nothing the bridge has not said", () => {
    const lights = buildViewLights(sources(), t);
    const unmatched = lights.find((l) => l.id === "hue-1");
    expect(unmatched).toMatchObject({ family: null, lightCount: null, lightIds: [], unmatched: true, ghost: false });
  });

  it("marks a matched channel the bridge no longer reports as a ghost, and none before the bridge is read", () => {
    expect(buildViewLights(sources(), t).find((l) => l.id === "hue-2")?.ghost).toBe(true);
    expect(buildViewLights(sources({ liveChannelIds: null }), t).find((l) => l.id === "hue-2")?.ghost).toBe(false);
  });

  it("names a channel by its label, else its bridge id", () => {
    const lights = buildViewLights(sources(), t);
    expect(lights.find((l) => l.id === "hue-2")?.name).toBe("Shelf");
    expect(lights.find((l) => l.id === "hue-0")?.name).toContain("#3");
  });

  it("offers no screen without a TV anchor", () => {
    expect(buildViewLights(sources({ config: { ...config, tvAnchor: undefined } }), t).some((l) => l.kind === "tv")).toBe(false);
  });
});

describe("resolveViewSelection", () => {
  it("shows a light, a strip or the screen as selected", () => {
    expect(resolveViewSelection(config, "hue-0")).toBe("hue-0");
    expect(resolveViewSelection(config, "usb-s1")).toBe("usb-s1");
    expect(resolveViewSelection(config, "tv")).toBe("tv");
  });

  it("shows nothing for furniture, a gone object or no selection", () => {
    expect(resolveViewSelection(config, "furniture-sofa")).toBeNull();
    expect(resolveViewSelection(config, "hue-9")).toBeNull();
    expect(resolveViewSelection(config, null)).toBeNull();
  });
});
