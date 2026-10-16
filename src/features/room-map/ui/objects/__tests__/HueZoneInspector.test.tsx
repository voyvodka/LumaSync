/**
 * HueZoneInspector — a zone is a rectangle: its width and depth in metres, each written as its own
 * cube scale (`width / roomWidth`, `depth / roomDepth`) and capped by the headroom Rust leaves a
 * zone near a wall. Its colour is one of the palette's six, and its lights join and leave from
 * their chips.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";

import { HueZoneInspector } from "../HueZoneInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

beforeEach(() => {
  cleanup();
});

const BASE_ZONE: HueZone = {
  id: "zone-1",
  name: "Sofa back-light",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  // 0.5 × 5 m = 2.5 m wide, 0.5 × 4 m = 2.0 m deep.
  scaleX: 0.5,
  scaleY: 0.5,
  scaleZ: 0.5,
  channelIndices: [],
  borderColor: "var(--lm-zone-1)",
};

function renderZone({
  zone = BASE_ZONE,
  roomWidthM = 5,
  roomDepthM = 4,
  zones = [zone],
  channels = [],
}: {
  zone?: HueZone;
  roomWidthM?: number;
  roomDepthM?: number;
  zones?: HueZone[];
  channels?: HueChannelPlacement[];
} = {}) {
  const handlers = {
    onUpdate: vi.fn<(patch: Partial<HueZone>) => void>(),
    onRename: vi.fn<(name: string) => void>(),
    onAssignChannel: vi.fn<(channelIndex: number, zoneId: string | null) => void>(),
    onDelete: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
  };
  render(
    <HueZoneInspector
      zone={zone}
      zoneIndex={0}
      zones={zones}
      channels={channels}
      roomWidthM={roomWidthM}
      roomDepthM={roomDepthM}
      {...handlers}
    />,
  );
  return {
    ...handlers,
    width: screen.getByTestId("hue-zone-width-input") as HTMLInputElement,
    depth: screen.getByTestId("hue-zone-depth-input") as HTMLInputElement,
  };
}

function commit(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("HueZoneInspector — width and depth", () => {
  it("shows each side in metres and writes it as that axis's cube scale alone", () => {
    const { onUpdate, width, depth } = renderZone();
    expect(width.value).toBe("2.50");
    expect(depth.value).toBe("2.00");
    commit(width, "3");
    expect(onUpdate).toHaveBeenLastCalledWith({ scaleX: expect.closeTo(0.6, 5) });
    commit(depth, "1");
    expect(onUpdate).toHaveBeenLastCalledWith({ scaleY: expect.closeTo(0.25, 5) });
  });

  it("reaches the walls and goes no further", () => {
    const { onUpdate, width, depth } = renderZone();
    expect(width).toHaveAttribute("aria-valuemax", "5");
    expect(depth).toHaveAttribute("aria-valuemax", "4");
    commit(width, "6");
    expect(onUpdate).not.toHaveBeenCalled();
    commit(width, "5");
    expect(onUpdate.mock.calls[0]![0].scaleX).toBeCloseTo(1, 5);
  });

  it("holds both sides while the room's size has not loaded, rather than dividing by it", () => {
    const { width, depth } = renderZone({ roomWidthM: 0, roomDepthM: 0 });
    expect(width).toBeDisabled();
    expect(depth).toBeDisabled();
  });
});

// Rust refuses `|center| + scale > 1` (`validate_zone_shape`). Bounding a side
// by the room alone let a wall-side zone grow past that, and the refusal was
// invisible because nothing read `status.code`.
describe("HueZoneInspector — headroom at the wall", () => {
  const NEAR_WALL: HueZone = { ...BASE_ZONE, centerX: 0.7, centerY: 0, scaleX: 0.2, scaleY: 0.25 };

  it("caps a side at the centre's remaining headroom, not the room's", () => {
    // centerX 0.7 leaves scaleX ≤ 0.3 → 1.5 m of a 5 m room.
    const { onUpdate, width } = renderZone({ zone: NEAR_WALL });
    expect(Number(width.getAttribute("aria-valuemax"))).toBeCloseTo(1.5, 5);
    commit(width, "1.5");
    const patch = onUpdate.mock.calls[0]![0];
    expect(Math.abs(NEAR_WALL.centerX) + patch.scaleX!).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("keeps a legacy escapee editable instead of collapsing its range", () => {
    const { width, depth } = renderZone({ zone: { ...BASE_ZONE, centerX: 1, centerY: 1, scaleX: 0.9, scaleY: 0.9 } });
    // Headroom is 0 on both axes; the floor keeps min ≤ max so the fields work.
    for (const field of [width, depth]) {
      expect(Number(field.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(Number(field.getAttribute("aria-valuemin")));
      expect(field).not.toBeDisabled();
    }
  });
});

describe("HueZoneInspector — colour", () => {
  it("writes a palette token, so the zone follows the theme", () => {
    const { onUpdate } = renderZone();
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:zoneProperties.swatch.rose" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ borderColor: "var(--lm-zone-5)" });
  });

  it("reads a colour stored as hex by the old inspector as its swatch", () => {
    renderZone({ zone: { ...BASE_ZONE, borderColor: "#10B981" } });
    expect(screen.getByRole("radio", { name: "roomMap:zoneProperties.swatch.emerald" })).toHaveAttribute("aria-checked", "true");
  });

  it("marks no swatch for a colour of the user's own, and keeps it until one is pressed", () => {
    const { onUpdate } = renderZone({ zone: { ...BASE_ZONE, borderColor: "#123456" } });
    for (const radio of screen.getAllByRole("radio")) expect(radio).toHaveAttribute("aria-checked", "false");
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("HueZoneInspector — its lights", () => {
  const lamp = (channelIndex: number, extra: Partial<HueChannelPlacement> = {}): HueChannelPlacement => ({
    channelIndex,
    channelId: channelIndex,
    x: 0,
    y: 0,
    z: 0,
    ...extra,
  });
  const other: HueZone = { ...BASE_ZONE, id: "zone-2", name: "Desk" };

  it("shows every light of the area as a chip, pressed when it is in the zone", () => {
    renderZone({ channels: [lamp(0, { zoneId: "zone-1" }), lamp(1)], zones: [BASE_ZONE, other] });
    expect(screen.getByTestId("hue-zone-chip-0")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("hue-zone-chip-1")).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a light with a press and takes it out with another", () => {
    const { onAssignChannel } = renderZone({ channels: [lamp(0, { zoneId: "zone-1" }), lamp(1)] });
    fireEvent.click(screen.getByTestId("hue-zone-chip-1"));
    expect(onAssignChannel).toHaveBeenLastCalledWith(1, "zone-1");
    fireEvent.click(screen.getByTestId("hue-zone-chip-0"));
    expect(onAssignChannel).toHaveBeenLastCalledWith(0, null);
  });

  it("says which zone a light is in now when it is another one", () => {
    renderZone({ channels: [lamp(1, { zoneId: "zone-2" })], zones: [BASE_ZONE, other] });
    expect(screen.getByTestId("hue-zone-chip-1").getAttribute("title")).toContain('roomMap:inspector.zoneChipElsewhere {"zone":"Desk"}');
  });

  it("leaves a locked light where it is: joining a zone moves it to the zone's centre", () => {
    const { onAssignChannel } = renderZone({ channels: [lamp(0, { locked: true })] });
    const chip = screen.getByTestId("hue-zone-chip-0");
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onAssignChannel).not.toHaveBeenCalled();
  });
});

describe("HueZoneInspector — name and actions", () => {
  it("renames, deletes and closes from its first row", () => {
    const handlers = renderZone();
    const name = screen.getByRole("textbox", { name: "roomMap:inspector.furnitureNameLabel" }) as HTMLInputElement;
    expect(name.value).toBe("Sofa back-light");
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Behind the sofa" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(handlers.onRename).toHaveBeenCalledWith("Behind the sofa");
    fireEvent.click(screen.getByRole("button", { name: "roomMap:objectPanel.delete" }));
    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.close" }));
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "roomMap:objectPanel.lock" })).toBeNull();
  });
});
