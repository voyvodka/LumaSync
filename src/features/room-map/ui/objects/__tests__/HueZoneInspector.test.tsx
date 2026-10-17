/**
 * HueZoneInspector — a zone is a cube in Hue units: one size as a share of the room, its sides in
 * metres beside it, and its centre's height. The size is capped by the headroom Rust leaves a zone
 * near a wall. Its colour is one of the palette's six, and its lights join and leave from their chips.
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
  // Half the room: 2.5 m wide, 2.0 m deep and 1.25 m high in a 5 × 4 × 2.5 m room.
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
  roomHeightM = 2.5,
  zones = [zone],
  channels = [],
}: {
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

describe("HueZoneInspector — size and height", () => {
  it("shows its size as a share of the room with its sides in metres, and writes it to all three axes", () => {
    const { onUpdate, size } = renderZone();
    expect(size.value).toBe("50");
    expect(screen.getByText('roomMap:inspector.zoneSizeReadout {"width":"2.50","depth":"2.00","height":"1.25"}')).toBeInTheDocument();
    commit(size, "30");
    expect(onUpdate).toHaveBeenLastCalledWith({ centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.3, scaleY: 0.3, scaleZ: 0.3 });
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
  const NEAR_WALL: HueZone = { ...BASE_ZONE, centerX: 0.7, centerY: 0, scaleX: 0.2, scaleY: 0.2, scaleZ: 0.2 };

  it("caps its size at the centre's remaining headroom, not the room's", () => {
    // centerX 0.7 leaves a scale of at most 0.3.
    const { onUpdate, size } = renderZone({ zone: NEAR_WALL });
    expect(size).toHaveAttribute("aria-valuemax", "30");
    commit(size, "30");
    const patch = onUpdate.mock.calls[0]![0];
    expect(Math.abs(NEAR_WALL.centerX) + patch.scaleX!).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("reaches the whole room from its middle and goes no further", () => {
    const { onUpdate, size } = renderZone();
    commit(size, "120");
    expect(onUpdate).not.toHaveBeenCalled();
    commit(size, "100");
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
