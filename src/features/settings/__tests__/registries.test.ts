import { describe, expect, it, vi } from "vitest";

import { SECTION_IDS, type SectionId } from "@/shared/contracts/shell";
import { OUTPUT_TARGETS, normalizeOutputTargets } from "@/shared/contracts/mode";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import type { Equals } from "@/test/typeEquals";

vi.mock("@/features/hue/useHueOnboarding", () => ({ useHueOnboarding: () => ({}) }));

import { SECTION_REGISTRY, type SectionEntry } from "../SettingsLayout";
import {
  DEVICE_CATEGORIES,
  type DeviceCategory,
  type DeviceCategoryDescriptor,
} from "../sections/DeviceSection";

describe("SECTION_REGISTRY", () => {
  it("has exactly one panel per section", () => {
    const covered: Equals<keyof typeof SECTION_REGISTRY, SectionId> = true;
    expect(covered).toBe(true);
    expect(Object.keys(SECTION_REGISTRY).sort()).toEqual(Object.values(SECTION_IDS).sort());
  });

  it("does not compile with a section missing", () => {
    const { [SECTION_IDS.ROOM_MAP]: _roomMap, ...withoutRoomMap } = SECTION_REGISTRY;
    // @ts-expect-error — the room map would have no panel.
    const incomplete = withoutRoomMap satisfies Record<SectionId, SectionEntry>;
    expect(Object.keys(incomplete)).not.toContain(SECTION_IDS.ROOM_MAP);
  });
});

describe("DEVICE_CATEGORIES", () => {
  it("has exactly one rail row per device category", () => {
    const covered: Equals<keyof typeof DEVICE_CATEGORIES, DeviceCategory> = true;
    expect(covered).toBe(true);
    expect(Object.keys(DEVICE_CATEGORIES)).toEqual(["usb", "hue", "wled", "displays", "manual"]);
  });

  it("does not compile with a category missing", () => {
    const { manual: _manual, ...withoutManual } = DEVICE_CATEGORIES;
    // @ts-expect-error — manual entry would have no rail button.
    const incomplete = withoutManual satisfies Record<DeviceCategory, DeviceCategoryDescriptor>;
    expect(Object.keys(incomplete)).not.toContain("manual");
  });
});

describe("OUTPUT_TARGETS", () => {
  it("lists every output target once, in the order a normalised list keeps", () => {
    const covered: Equals<(typeof OUTPUT_TARGETS)[number], HueRuntimeTarget> = true;
    expect(covered).toBe(true);
    expect(OUTPUT_TARGETS).toEqual(["usb", "hue"]);
    expect(normalizeOutputTargets(["hue", "bogus", "usb", "hue"])).toEqual(["usb", "hue"]);
  });

  it("does not compile with a target missing a rank", () => {
    // @ts-expect-error — Hue would have no place in the list.
    const incomplete = { usb: 0 } satisfies Record<HueRuntimeTarget, number>;
    expect(incomplete).toEqual({ usb: 0 });
  });
});
