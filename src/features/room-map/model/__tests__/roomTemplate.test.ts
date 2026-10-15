// Connecting a controller on Devices → USB writes a port-linked strip into the
// room map. That strip made the map "not empty", so a USB user never saw the
// template picker; and a template replaced the whole map, strip included.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROOM_MAP,
  type HueChannelPlacement,
  type RoomMapConfig,
  type UsbStripPlacement,
} from "@/shared/contracts/roomMap";

import { applyRoomTemplate, isRoomMapEmpty } from "../roomTemplate";

const PORT = "/dev/cu.usbserial-1420";

function strip(overrides: Partial<UsbStripPlacement> = {}): UsbStripPlacement {
  return { stripId: "usb-a", startX: 1, startY: 1, endX: 4, endY: 1, ledCount: 118, ...overrides };
}

function map(overrides: Partial<RoomMapConfig> = {}): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

const TV_TEMPLATE = map({
  tvAnchor: { x: 1.75, y: 0.2, width: 1.2, height: 0.08 },
  usbStrips: [{ stripId: "usb-tv", startX: 1.85, startY: 0.15, endX: 2.85, endY: 0.15, ledCount: 60 }],
  furniture: [{ id: "sofa-1", type: "sofa", x: 1.5, y: 2.8, width: 2, height: 0.8, label: "Sofa" }],
});

describe("isRoomMapEmpty", () => {
  it("still offers templates when the only strip is the one a connect added", () => {
    expect(isRoomMapEmpty(map({ usbStrips: [strip({ portName: PORT })] }))).toBe(true);
  });

  it("still offers them with the Hue channels the bridge seeded, which a template keeps", () => {
    const channel = { channelIndex: 0, x: 1, y: 1, z: 0 } as HueChannelPlacement;
    expect(isRoomMapEmpty(map({ hueChannels: [channel] }))).toBe(true);
  });

  it("does not when the user drew a strip, placed a TV or furniture", () => {
    expect(isRoomMapEmpty(map({ usbStrips: [strip()] }))).toBe(false);
    expect(isRoomMapEmpty(map({ tvAnchor: TV_TEMPLATE.tvAnchor }))).toBe(false);
    expect(isRoomMapEmpty(map({ furniture: TV_TEMPLATE.furniture }))).toBe(false);
  });

  it("does not once the room is drawn into another shape, and does for a footprint it cannot read", () => {
    const base = map({});
    const { widthMeters: w, depthMeters: d } = base.dimensions;
    const L = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: d / 2 },
      { x: w / 2, y: d / 2 },
      { x: w / 2, y: d },
      { x: 0, y: d },
    ];
    expect(isRoomMapEmpty({ ...base, footprint: L })).toBe(false);
    expect(isRoomMapEmpty({ ...base, footprint: L.slice(0, 5) })).toBe(true);
  });
});

describe("applyRoomTemplate", () => {
  it("leaves the room's outline behind, as Reset does", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 2 },
      { x: 3, y: 2 },
      { x: 3, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(applyRoomTemplate({ ...map({}), footprint: L }, TV_TEMPLATE).footprint).toBeUndefined();
  });

  it("puts the connected strip where the template's strip goes, keeping its port and LED count", () => {
    const connected = strip({ stripId: "usb-conn", portName: PORT });
    const next = applyRoomTemplate(map({ usbStrips: [connected] }), TV_TEMPLATE);

    expect(next.tvAnchor).toEqual(TV_TEMPLATE.tvAnchor);
    expect(next.furniture).toEqual(TV_TEMPLATE.furniture);
    expect(next.usbStrips).toEqual([
      { stripId: "usb-conn", startX: 1.85, startY: 0.15, endX: 2.85, endY: 0.15, ledCount: 118, portName: PORT },
    ]);
  });

  it("keeps a second controller's strip beside it", () => {
    const first = strip({ stripId: "usb-1", portName: PORT });
    const second = strip({ stripId: "usb-2", portName: "/dev/cu.usbserial-9" });
    const next = applyRoomTemplate(map({ usbStrips: [first, second] }), TV_TEMPLATE);

    expect(next.usbStrips.map((s) => [s.stripId, s.portName])).toEqual([
      ["usb-1", PORT],
      ["usb-2", "/dev/cu.usbserial-9"],
    ]);
  });

  it("keeps connected strips under the empty template", () => {
    const connected = strip({ portName: PORT });
    expect(applyRoomTemplate(map({ usbStrips: [connected] }), DEFAULT_ROOM_MAP).usbStrips).toEqual([connected]);
  });

  it("is the template as-is when nothing is connected", () => {
    expect(applyRoomTemplate(map(), TV_TEMPLATE).usbStrips).toEqual(TV_TEMPLATE.usbStrips);
  });

  // Channels of another entertainment area are hidden, so the map reads empty.
  it("leaves the Hue data the bridge sync owns alone", () => {
    const channel = { channelIndex: 0, x: 1, y: 1, z: 0 } as HueChannelPlacement;
    const next = applyRoomTemplate(map({ hueChannels: [channel] }), TV_TEMPLATE);
    expect(next.hueChannels).toEqual([channel]);
  });
});
