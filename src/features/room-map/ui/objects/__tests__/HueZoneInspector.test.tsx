/**
 * HueZoneInspector — a zone is a cube in metres: one edge and its centre's height. The edge is capped
 * by the ceiling and by the headroom Rust leaves a zone near a wall. Its colour is one of the
 * palette's six, and its lights join and leave from their chips.
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
  // A 1.25 m cube in a 5 × 4 × 2.5 m room.
  scaleX: 0.25,
  scaleY: 0.3125,
  scaleZ: 0.5,
  channelIndices: [],
  borderColor: "var(--lm-zone-1)",
};

function renderZone({
  zone = BASE_ZONE,
  roomWidthM = 5,
  roomDepthM = 4,
  roomHeightM = 2.5,
  zones = [zone],
  channels = [],
  onPreview,
}: {
  onPreview?: (zone: HueZone | null) => boolean;
  zone?: HueZone;
  roomWidthM?: number;
  roomDepthM?: number;
  roomHeightM?: number;
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
      roomHeightM={roomHeightM}
      onPreview={onPreview}
      {...handlers}
    />,
  );
  return {
    ...handlers,
    size: screen.getByTestId("hue-zone-size-input") as HTMLInputElement,
    height: screen.getByTestId("hue-zone-height-input") as HTMLInputElement,
  };
}

function commit(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function drag(input: HTMLInputElement, toX: number) {
  const box = input.closest("label")!;
  fireEvent.pointerDown(box, { button: 0, clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(box, { clientX: 100 + toX / 2, pointerId: 1 });
  fireEvent.pointerMove(box, { clientX: 100 + toX, pointerId: 1 });
  fireEvent.pointerUp(box, { pointerId: 1 });
}

describe("HueZoneInspector — a drag across a field", () => {
  it("is shown held while it lasts and saved once, when let go", () => {
    const onPreview = vi.fn<(zone: HueZone | null) => boolean>(() => true);
    const { onUpdate, size } = renderZone({ onPreview });
    const box = size.closest("label")!;
    fireEvent.pointerDown(box, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 120, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 140, pointerId: 1 });
    // Ten steps of 5 cm: 1.25 m to 1.75 m, shown in the field and the room but not saved.
    expect(size.value).toBe("1.75");
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ scaleX: 0.35, scaleZ: 0.7 }));
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.pointerUp(box, { pointerId: 1 });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith({ centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.35, scaleY: 0.4375, scaleZ: 0.7 });
    // Saved, the zone stays held until the room is built with it.
    expect(onPreview).not.toHaveBeenCalledWith(null);
  });

  it("puts the zone back when the drag ends where it began", () => {
    const onPreview = vi.fn<(zone: HueZone | null) => boolean>(() => true);
    const { onUpdate, height } = renderZone({ onPreview });
    const box = height.closest("label")!;
    fireEvent.pointerDown(box, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 120, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("saves each step where no room view can show it", () => {
    const onPreview = vi.fn<(zone: HueZone | null) => boolean>(() => false);
    const { onUpdate, size } = renderZone({ onPreview });
    drag(size, 40);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ scaleX: 0.35 }));
  });
});

describe("HueZoneInspector — size and height", () => {
  it("shows its edge in metres and writes it over each side of the room", () => {
    const { onUpdate, size } = renderZone();
    expect(size.value).toBe("1.25");
    commit(size, "0.75");
    expect(onUpdate).toHaveBeenLastCalledWith({ centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.15, scaleY: 0.1875, scaleZ: 0.3 });
  });

  it("shows its centre's height in metres and moves it between the floor and the ceiling", () => {
    const { onUpdate, height } = renderZone();
    expect(height.value).toBe("1.25");
    expect(Number(height.getAttribute("aria-valuemin"))).toBeCloseTo(0.63, 2);
    expect(Number(height.getAttribute("aria-valuemax"))).toBeCloseTo(1.88, 2);
    commit(height, "1.5");
    expect(onUpdate.mock.calls[0]![0].centerZ).toBeCloseTo(0.2, 5);
  });

  it("holds both fields while the room's size has not loaded, rather than dividing by it", () => {
    const { size, height } = renderZone({ roomWidthM: 0, roomDepthM: 0, roomHeightM: 0 });
    expect(size).toBeDisabled();
    expect(height).toBeDisabled();
  });
});

// Rust refuses `|center| + scale > 1` (`validate_zone_shape`). Bounding the size
// by the room alone let a wall-side zone grow past that, and the refusal was
// invisible because nothing read `status.code`.
describe("HueZoneInspector — headroom at the wall", () => {
  const NEAR_WALL: HueZone = { ...BASE_ZONE, centerX: 0.7, centerY: 0, scaleX: 0.2, scaleY: 0.25, scaleZ: 0.4 };

  it("caps its edge at the centre's remaining headroom, not the room's", () => {
    // centerX 0.7 leaves a scale of at most 0.3 of the 5 m width: 1.5 m.
    const { onUpdate, size } = renderZone({ zone: NEAR_WALL });
    expect(size).toHaveAttribute("aria-valuemax", "1.5");
    commit(size, "1.5");
    const patch = onUpdate.mock.calls[0]![0];
    expect(Math.abs(NEAR_WALL.centerX) + patch.scaleX!).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("reaches the ceiling from the middle and goes no further", () => {
    const { onUpdate, size } = renderZone();
    commit(size, "3");
    expect(onUpdate).not.toHaveBeenCalled();
    commit(size, "2.5");
    expect(onUpdate.mock.calls[0]![0].scaleZ).toBeCloseTo(1, 5);
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
