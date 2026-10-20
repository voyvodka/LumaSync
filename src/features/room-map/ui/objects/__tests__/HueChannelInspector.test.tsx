// The slider stays in Hue's [-1, 1] because that is what is persisted; only the
// readout is metres. `aria-valuetext` is the gain over the Devices strip.
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HueChannelInspector } from "../HueChannelInspector";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

const FIXTURE_LOCALES: Record<string, string> = {
  "roomMap:inspector.hueHeightAriaLabel": "Channel height, floor to ceiling",
  "roomMap:inspector.hueHeightFloor": "floor level",
  "roomMap:inspector.hueHeightEye": "eye level",
  "roomMap:inspector.hueHeightCeiling": "ceiling level",
  "roomMap:inspector.hueHeightValueText": "{{metres}} m — {{label}}",
  "roomMap:inspector.hueHeightReadout": "{{metres}} m",
  "roomMap:inspector.hueHeightZoneShort": "zone: {{min}}–{{max}} m",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = FIXTURE_LOCALES[key] ?? key;
      if (!opts) return template;
      return Object.entries(opts).reduce(
        (acc, [k, v]) => acc.split(`{{${k}}}`).join(String(v)),
        template,
      );
    },
  }),
}));

const channel: HueChannelPlacement = { channelIndex: 0, x: 0, y: 0, z: 0 };

function renderInspector(worldZ: number, onHeightChange = vi.fn(), locked = false) {
  render(
    <HueChannelInspector
      channel={locked ? { ...channel, locked: true } : channel}
      zones={[]}
      worldZ={worldZ}
      roomHeightMeters={2.5}
      world={{ x: 0, y: 0 }}
      roomWidthMeters={5}
      roomDepthMeters={4}
      onMove={vi.fn<(x: number, y: number) => void>()}
      onHeightChange={onHeightChange}
      onRename={vi.fn()}
      onToggleLock={vi.fn()}
      onClose={vi.fn<() => void>()}
    />,
  );
  return onHeightChange;
}

describe("HueChannelInspector height control", () => {
  beforeEach(cleanup);

  it("announces the height in metres, not the stored -1..1 value", () => {
    renderInspector(0);
    const slider = screen.getByRole("slider");
    // Mid-range in a 2.5 m room is 1.25 m, and the raw value is 0.
    expect(slider.getAttribute("aria-valuetext")).toBe("1.25 m — eye level");
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
  });

  it("names the band the height falls in", () => {
    renderInspector(-1);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("0.00 m — floor level");
    cleanup();
    renderInspector(1);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("2.50 m — ceiling level");
  });

  it("reports the edited height in world coordinates, not metres", () => {
    const onHeightChange = renderInspector(0);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.6" } });
    expect(onHeightChange).toHaveBeenCalledWith(0.6);
  });

  it("is disabled on a locked channel, like the label field beside it", () => {
    renderInspector(0, vi.fn(), true);
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Identity — the bridge's own id, never our ordinal
// ---------------------------------------------------------------------------

describe("channel identity", () => {
  /** Ordinal 2, bridge id 5 — they disagree, which is the whole point. */
  const gapped: HueChannelPlacement = { channelIndex: 2, channelId: 5, x: 0, y: 0, z: 0 };

  function renderChannel(ch: HueChannelPlacement, extra: Record<string, unknown> = {}) {
    render(
      <HueChannelInspector
        channel={ch}
        zones={[]}
        worldZ={0}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={vi.fn()}
        onRename={vi.fn()}
        onToggleLock={vi.fn()}
        onClose={vi.fn<() => void>()}
        {...extra}
      />,
    );
  }

  it("shows the bridge id, not the ordinal and not the ordinal plus one", () => {
    renderChannel(gapped);
    expect(screen.getByText("#5")).toBeTruthy();
    expect(screen.queryByText("3")).toBeNull();
    expect(screen.queryByText("#3")).toBeNull();
  });

  it("names channel #0 rather than dropping a falsy id", () => {
    renderChannel({ channelIndex: 0, channelId: 0, x: 0, y: 0, z: 0 });
    expect(screen.getByText("#0")).toBeTruthy();
  });

  it("says the placement is unmatched when it carries no bridge id", () => {
    renderChannel({ channelIndex: 2, x: 0, y: 0, z: 0 });
    expect(screen.getByText("roomMap:inspector.hueChannelUnresolved")).toBeTruthy();
  });

  it("reports how many bulbs the channel drives", () => {
    renderChannel(gapped, { lightCount: 3 });
    expect(screen.getByText(/hueLights/)).toBeTruthy();
  });

  it("uses the singular for one bulb", () => {
    renderChannel(gapped, { lightCount: 1 });
    expect(screen.getByText(/roomMap:inspector\.hueOneLight/)).toBeTruthy();
  });

  it("omits the count rather than showing zero when the bridge has not said", () => {
    renderChannel(gapped, { lightCount: null });
    expect(screen.getByText("#5")).toBeTruthy();
    expect(screen.queryByText(/hueLights|hueOneLight/)).toBeNull();
  });

  it("says in a word that the bridge no longer reports the channel, the sentence as its tooltip", () => {
    renderChannel(gapped, { isGhost: true });
    const note = screen.getByText("roomMap:inspector.hueGhostShort");
    expect(note.closest("[title]")).toHaveAttribute("title", "roomMap:inspector.hueChannelGhostNote");
  });

  it("says nothing about ghosts for a channel the bridge still reports", () => {
    renderChannel(gapped);
    expect(screen.queryByText("roomMap:inspector.hueGhostShort")).toBeNull();
  });

  it("edits the user's own name, with the bridge's name as the fallback", () => {
    const onRename = vi.fn<(label: string) => void>();
    renderChannel(gapped, { onRename });
    const name = screen.getByRole("textbox", { name: "roomMap:inspector.furnitureNameLabel" }) as HTMLInputElement;
    expect(name.value).toBe("roomMap:hueChannel.defaultLabel");
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Floor lamp" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("Floor lamp");
  });
});

describe("HueChannelInspector height inside a zone", () => {
  beforeEach(cleanup);

  const zone = {
    id: "zone-a",
    name: "Sofa",
    entertainmentAreaId: "area-1",
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    scaleX: 0.5,
    scaleY: 0.5,
    scaleZ: 0.5,
    channelIndices: [0],
    borderColor: "#3b82f6",
  };

  it("limits the slider to the heights the zone lets the channel reach, and says why", () => {
    render(
      <HueChannelInspector
        channel={{ ...channel, zoneId: "zone-a", zoneRelativePosition: { x: 0, y: 0, z: 0 } }}
        zones={[zone]}
        worldZ={0}
        heightRange={{ min: -0.5, max: 0.5, zone }}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={vi.fn<(worldZ: number) => void>()}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuemin")).toBe("-0.5");
    expect(slider.getAttribute("aria-valuemax")).toBe("0.5");
    expect(screen.getByText("zone: 0.63–1.88 m")).toBeInTheDocument();
  });

  it("shows no limit for a zone as tall as the room", () => {
    render(
      <HueChannelInspector
        channel={channel}
        zones={[]}
        worldZ={0}
        heightRange={{ min: -1, max: 1, zone }}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={vi.fn<(worldZ: number) => void>()}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );
    expect(screen.queryByText(/^zone:/)).toBeNull();
  });
});

describe("HueChannelInspector position", () => {
  beforeEach(cleanup);

  function renderAt(world: { x: number; y: number }, locked = false) {
    const onMove = vi.fn<(x: number, y: number) => void>();
    render(
      <HueChannelInspector
        channel={locked ? { ...channel, locked: true } : channel}
        zones={[]}
        world={world}
        worldZ={0}
        roomWidthMeters={5}
        roomDepthMeters={4}
        roomHeightMeters={2.5}
        onMove={onMove}
        onHeightChange={vi.fn<(worldZ: number) => void>()}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );
    const field = (name: string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
    return { onMove, x: field("roomMap:inspector.xLabel"), y: field("roomMap:inspector.yLabel") };
  }

  it("reads in metres on the plan, x from the left wall and y from the TV wall", () => {
    // Cube (0.5, 0.5): three quarters across a 5 m room, a quarter of the way back from the TV wall.
    const { x, y } = renderAt({ x: 0.5, y: 0.5 });
    expect(x.value).toBe("3.75");
    expect(y.value).toBe("1.00");
  });

  it("writes a typed metre back as a cube position, keeping the other axis", () => {
    const { onMove, x, y } = renderAt({ x: 0.5, y: 0.5 });
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "1.25" } });
    fireEvent.keyDown(x, { key: "Enter" });
    const [cubeX, cubeY] = onMove.mock.calls[0];
    expect(cubeX).toBeCloseTo(-0.5, 6);
    expect(cubeY).toBeCloseTo(0.5, 6);

    fireEvent.focus(y);
    fireEvent.change(y, { target: { value: "4" } });
    fireEvent.keyDown(y, { key: "Enter" });
    expect(onMove.mock.calls[1][1]).toBeCloseTo(-1, 6);
  });

  it("keeps a typed position inside the room, and still while locked", () => {
    const { onMove, x } = renderAt({ x: 0, y: 0 });
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "6" } });
    fireEvent.blur(x);
    expect(onMove).not.toHaveBeenCalled();

    cleanup();
    expect(renderAt({ x: 0, y: 0 }, true).x).toBeDisabled();
  });
});

describe("HueChannelInspector zone", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const zone = (id: string, name: string) => ({
    id,
    name,
    entertainmentAreaId: "area-1",
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    scaleX: 0.5,
    scaleY: 0.5,
    scaleZ: 0.5,
    channelIndices: [],
    borderColor: "var(--lm-zone-1)",
  });

  function renderWithZones(ch: HueChannelPlacement, zones: ReturnType<typeof zone>[]) {
    const onAssignZone = vi.fn<(zoneId: string | null) => void>();
    render(
      <HueChannelInspector
        channel={ch}
        zones={zones}
        worldZ={0}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={vi.fn<(worldZ: number) => void>()}
        onAssignZone={onAssignZone}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );
    return onAssignZone;
  }
  const picker = () => screen.getByRole("button", { name: /^roomMap:inspector\.hueZoneLabel: / });

  it("moves the light into a zone, or out of every zone, from its picker", () => {
    const onAssignZone = renderWithZones({ ...channel, zoneId: "a" }, [zone("a", "Sofa"), zone("b", "Desk")]);
    expect(picker().textContent).toContain("Sofa");
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole("option", { name: "Desk" }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onAssignZone).toHaveBeenLastCalledWith("b");

    fireEvent.click(picker());
    fireEvent.click(screen.getByRole("option", { name: "roomMap:hueZones.unassignedTitle" }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onAssignZone).toHaveBeenLastCalledWith(null);
  });

  it("reads a zone the area no longer has as no zone, rather than its raw id", () => {
    renderWithZones({ ...channel, zoneId: "gone" }, [zone("a", "Sofa")]);
    expect(picker().textContent).toContain("roomMap:hueZones.unassignedTitle");
    expect(picker().textContent).not.toContain("gone");
  });

  it("offers no picker to open with no zone to join, or while the light is locked", () => {
    renderWithZones(channel, []);
    expect(picker()).toBeDisabled();
    cleanup();
    renderWithZones({ ...channel, locked: true }, [zone("a", "Sofa")]);
    expect(picker()).toBeDisabled();
  });
});

describe("HueChannelInspector model and facing", () => {
  beforeEach(cleanup);

  const renderModel = (stored: Partial<HueChannelPlacement>, bridgeFixture: "playBar" | "floorLamp" | null) => {
    const onUpdate = vi.fn<(patch: Pick<HueChannelPlacement, "facing" | "fixture">) => void>();
    render(
      <HueChannelInspector
        channel={{ ...channel, ...stored }}
        zones={[]}
        worldZ={0}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={vi.fn<(z: number) => void>()}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        modelChoices
        bridgeFixture={bridgeFixture}
        autoFacing={270}
        onUpdate={onUpdate}
      />,
    );
    return onUpdate;
  };

  // The user's light lights one way, at the wall it is turned to; the room must be told which way.
  it("offers a facing for a one-sided light, empty meaning its nearest wall", () => {
    const onUpdate = renderModel({}, "playBar");
    const facing = screen.getByLabelText("roomMap:inspector.hueFacingLabel") as HTMLInputElement;
    expect(facing.placeholder).toBe("270");
    fireEvent.change(facing, { target: { value: "90" } });
    fireEvent.keyDown(facing, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith({ facing: 90 });
  });

  // Hidden for a light that lights all round, the field took the row's next parts with it.
  it("holds the facing in its place but off for a light that lights all round, unless its model is one-sided", () => {
    renderModel({}, "floorLamp");
    expect((screen.getByLabelText("roomMap:inspector.hueFacingLabel") as HTMLInputElement).disabled).toBe(true);
    cleanup();
    renderModel({ fixture: "iris" }, "floorLamp");
    expect((screen.getByLabelText("roomMap:inspector.hueFacingLabel") as HTMLInputElement).disabled).toBe(false);
  });

  it("says what Auto means under the model list, with no separate ⓘ", () => {
    renderModel({}, "playBar");
    expect(screen.queryByRole("button", { name: "common:hintFor" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^roomMap:inspector.modelLabel/ }));
    expect(screen.getByText("roomMap:inspector.hueModelInfo")).toBeInTheDocument();
  });
});

describe("HueChannelInspector hanging from the ceiling", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const renderHang = (worldZ: number, stored: Partial<HueChannelPlacement> = {}, maxZ = 1) => {
    const onUpdate = vi.fn<(patch: Pick<HueChannelPlacement, "facing" | "fixture">, worldZ?: number) => void>();
    const onHeightChange = vi.fn<(z: number) => void>();
    render(
      <HueChannelInspector
        channel={{ ...channel, ...stored }}
        zones={[]}
        worldZ={worldZ}
        heightRange={{ min: -1, max: maxZ, zone: null }}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={onHeightChange}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        modelChoices
        onUpdate={onUpdate}
      />,
    );
    return { onUpdate, onHeightChange };
  };
  const pickModel = (option: string) => {
    fireEvent.click(screen.getByRole("button", { name: /^roomMap:inspector\.modelLabel: / }));
    fireEvent.click(screen.getByRole("option", { name: option }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
  };

  // Drawn on the ceiling but sampled where it stood: the stream had it at the floor.
  it("takes a light chosen as a ceiling light up to the ceiling, in the same step", () => {
    const { onUpdate } = renderHang(-1);
    pickModel("roomMap:view.family.ceiling");
    expect(onUpdate).toHaveBeenLastCalledWith({ fixture: "ceiling" }, 1);
  });

  it("hangs a pendant's shade below the ceiling, and leaves one already hung where it is", () => {
    const { onUpdate } = renderHang(-1);
    pickModel("roomMap:view.family.pendant");
    expect(onUpdate.mock.lastCall?.[1]).toBeCloseTo(((2.5 - 0.75) / 2.5) * 2 - 1);
    cleanup();
    const hung = renderHang(0.2).onUpdate;
    pickModel("roomMap:view.family.pendant");
    expect(hung).toHaveBeenLastCalledWith({ fixture: "pendant" }, undefined);
  });

  it("moves no light chosen as one that stands", () => {
    const { onUpdate } = renderHang(-1);
    pickModel("roomMap:view.family.floorLamp");
    expect(onUpdate).toHaveBeenLastCalledWith({ fixture: "floorLamp" }, undefined);
  });

  it("offers to hang a bulb from the ceiling, and says nothing once it hangs there", () => {
    const { onHeightChange } = renderHang(-1);
    fireEvent.click(screen.getByText("roomMap:inspector.hueHang"));
    expect(onHeightChange).toHaveBeenCalledWith(1);
    cleanup();
    renderHang(1);
    expect(screen.queryByText("roomMap:inspector.hueHang")).toBeNull();
  });

  it("offers nothing for a floor lamp, or where the light's zone stops below the ceiling", () => {
    renderHang(-1, { fixture: "floorLamp" });
    expect(screen.queryByText("roomMap:inspector.hueHang")).toBeNull();
    cleanup();
    renderHang(-1, {}, 0.2);
    expect(screen.queryByText("roomMap:inspector.hueHang")).toBeNull();
  });
});

describe("HueChannelInspector standing on a piece", () => {
  beforeEach(cleanup);

  const renderSeat = (worldZ: number, stored: Partial<HueChannelPlacement> = {}) => {
    const onHeightChange = vi.fn<(z: number) => void>();
    render(
      <HueChannelInspector
        channel={{ ...channel, ...stored }}
        zones={[]}
        worldZ={worldZ}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={vi.fn<(x: number, y: number) => void>()}
        onHeightChange={onHeightChange}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        seat={{ item: { id: "desk", type: "table", x: 0, y: 0, width: 1, height: 1, label: "Desk" }, top: 0.75 }}
      />,
    );
    return onHeightChange;
  };

  it("offers to stand a light on the piece under it, at the piece's top", () => {
    const onHeightChange = renderSeat(-1);
    fireEvent.click(screen.getByText("roomMap:inspector.hueSeatOn"));
    expect(onHeightChange).toHaveBeenCalledWith(0.75 / 2.5 * 2 - 1);
  });

  it("says nothing once the light stands on it", () => {
    renderSeat(0.8 / 2.5 * 2 - 1);
    expect(screen.queryByText("roomMap:inspector.hueSeatOn")).toBeNull();
  });

  it("offers no ceiling to a bulb on a piece, which is a lamp's", () => {
    renderSeat(-1);
    expect(screen.queryByText("roomMap:inspector.hueHang")).toBeNull();
  });

  // A link that came with a new height shrank the slider, and the thumb jumped under the pointer.
  it("keeps the slider's place whether a link is offered or not", () => {
    const parts = () => {
      const slider = screen.getByRole("slider").closest("label")!;
      const row = slider.parentElement!;
      return { index: [...row.children].indexOf(slider), count: row.children.length, flex: slider.style.flex };
    };
    renderSeat(-1);
    expect(screen.getByText("roomMap:inspector.hueSeatOn")).toBeInTheDocument();
    const offered = parts();
    cleanup();
    renderSeat(0.8 / 2.5 * 2 - 1);
    expect(parts()).toEqual(offered);
    expect(offered.flex).toBe("0 1 176px");
  });

  it("offers no piece to stand a pendant or a ceiling light on", () => {
    renderSeat(0, { fixture: "pendant" });
    expect(screen.queryByText("roomMap:inspector.hueSeatOn")).toBeNull();
  });
});

describe("HueChannelInspector — a drag across its fields", () => {
  beforeEach(cleanup);

  function renderHeld(onPreview: (next: HueChannelPlacement | null) => boolean) {
    const onMove = vi.fn<(x: number, y: number) => void>();
    const onHeightChange = vi.fn<(z: number) => void>();
    render(
      <HueChannelInspector
        channel={channel}
        zones={[]}
        worldZ={0}
        roomHeightMeters={2.5}
        world={{ x: 0, y: 0 }}
        roomWidthMeters={5}
        roomDepthMeters={4}
        onMove={onMove}
        onHeightChange={onHeightChange}
        onPreview={onPreview}
        onRename={vi.fn<(label: string) => void>()}
        onToggleLock={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
      />,
    );
    return { onMove, onHeightChange };
  }

  it("shows the light where X has put it while held, and moves it once, when let go", () => {
    const onPreview = vi.fn<(next: HueChannelPlacement | null) => boolean>(() => true);
    const { onMove } = renderHeld(onPreview);
    const box = screen.getByRole("spinbutton", { name: "roomMap:inspector.xLabel" }).closest("label")!;
    fireEvent.pointerDown(box, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 120, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 140, pointerId: 1 });
    // Ten steps of 5 cm from the middle of a 5 m room: 3 m, or 0.2 in Hue units.
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ x: expect.closeTo(0.2, 5), y: 0 }));
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerUp(box, { pointerId: 1 });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]![0]).toBeCloseTo(0.2, 5);
  });

  it("holds the height slider the same way and writes it where it is let go", () => {
    const onPreview = vi.fn<(next: HueChannelPlacement | null) => boolean>(() => true);
    const { onHeightChange } = renderHeld(onPreview);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "0.3" } });
    fireEvent.change(slider, { target: { value: "0.6" } });
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ z: 0.6, zOrigin: "user" }));
    expect(onHeightChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(0.6);
  });

  it("writes each step where no room view can show it", () => {
    const { onHeightChange } = renderHeld(() => false);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.6" } });
    expect(onHeightChange).toHaveBeenCalledWith(0.6);
  });
});
