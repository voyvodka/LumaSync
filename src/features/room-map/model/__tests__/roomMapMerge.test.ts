import { describe, expect, it } from "vitest";

import type { HueChannelPlacement, RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { mergeEditorSave } from "../roomMapMerge";

const strip = (stripId: string, ledCount = 60): UsbStripPlacement => ({
  stripId,
  startX: 0,
  startY: 0,
  endX: 1,
  endY: 0,
  ledCount,
});

const channel = (channelIndex: number, area: string | null, x = 0): HueChannelPlacement => ({
  channelIndex,
  entertainmentAreaId: area,
  x,
  y: 0,
  z: 0,
});

const map = (patch: Partial<RoomMapConfig>): RoomMapConfig => ({ ...DEFAULT_ROOM_MAP, ...patch });

describe("mergeEditorSave", () => {
  it("keeps a strip another writer added while the editor changed something else", () => {
    const base = map({ usbStrips: [strip("a")] });
    const next = { ...base, dimensions: { ...base.dimensions, widthMeters: 7 } };
    const stored = { ...base, usbStrips: [strip("a"), strip("b")] };

    const saved = mergeEditorSave(stored, base, next);

    expect(saved.usbStrips.map((s) => s.stripId)).toEqual(["a", "b"]);
    expect(saved.dimensions.widthMeters).toBe(7);
  });

  it("keeps a strip another writer added while the editor moved a different strip", () => {
    const a = strip("a");
    const base = map({ usbStrips: [a] });
    const next = { ...base, usbStrips: [{ ...a, endX: 2 }] };
    const stored = { ...base, usbStrips: [a, strip("b")] };

    const saved = mergeEditorSave(stored, base, next);

    expect(saved.usbStrips).toEqual([{ ...a, endX: 2 }, strip("b")]);
  });

  it("keeps an LED count another writer synced on a strip the editor did not touch", () => {
    const [a, b] = [strip("a"), strip("b")];
    const base = map({ usbStrips: [a, b] });
    const next = { ...base, usbStrips: [{ ...a, endX: 2 }, b] };
    const stored = { ...base, usbStrips: [a, { ...b, ledCount: 120 }] };

    expect(mergeEditorSave(stored, base, next).usbStrips[1].ledCount).toBe(120);
  });

  it("keeps a field another writer set on a strip the editor moved", () => {
    const a = strip("a");
    const base = map({ usbStrips: [a] });
    const next = { ...base, usbStrips: [{ ...a, endX: 2 }] };
    const stored = { ...base, usbStrips: [{ ...a, portName: "/dev/cu.usbserial-1", ledCount: 120 }] };

    expect(mergeEditorSave(stored, base, next).usbStrips).toEqual([
      { ...a, endX: 2, portName: "/dev/cu.usbserial-1", ledCount: 120 },
    ]);
  });

  it("removes what the editor deleted and adds what it created", () => {
    const [a, b] = [strip("a"), strip("b")];
    const base = map({ usbStrips: [a, b] });
    const next = { ...base, usbStrips: [b, strip("c")] };

    expect(mergeEditorSave(base, base, next).usbStrips.map((s) => s.stripId)).toEqual(["b", "c"]);
  });

  it("keeps another area's channel placements and replaces an adopted unscoped record", () => {
    const unscoped = channel(0, null);
    const base = map({ hueChannels: [unscoped] });
    const next = { ...base, hueChannels: [channel(0, "A", 0.5)] };
    const stored = { ...base, hueChannels: [unscoped, channel(0, "B", -0.5)] };

    const saved = mergeEditorSave(stored, base, next);

    expect(saved.hueChannels).toEqual([channel(0, "B", -0.5), channel(0, "A", 0.5)]);
  });

  it("drops a field the editor removed", () => {
    const base = { ...map({}), backgroundImagePath: "/old.png" };
    const next = map({ imageLayers: [] });

    const saved = mergeEditorSave(base, base, next);

    expect("backgroundImagePath" in JSON.parse(JSON.stringify(saved))).toBe(false);
  });

  it("writes the editor's map whole when it has no baseline", () => {
    const next = map({ usbStrips: [strip("a")] });
    const stored = map({ usbStrips: [strip("a"), strip("b")] });

    expect(mergeEditorSave(stored, null, next)).toBe(next);
  });
});
