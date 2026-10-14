// The slider stays in Hue's [-1, 1] because that is what is persisted; only the
// readout is metres. `aria-valuetext` is the gain over the Devices strip.
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HueChannelInspector } from "../HueChannelInspector";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

const FIXTURE_LOCALES: Record<string, string> = {
  "roomMap:inspector.hueHeightLabel": "Height",
  "roomMap:inspector.hueHeightAriaLabel": "Channel height, floor to ceiling",
  "roomMap:inspector.hueHeightFloor": "floor level",
  "roomMap:inspector.hueHeightEye": "eye level",
  "roomMap:inspector.hueHeightCeiling": "ceiling level",
  "roomMap:inspector.hueHeightValueText": "{{metres}} m — {{label}}",
  "roomMap:inspector.hueHeightReadout": "{{metres}} m",
  "roomMap:inspector.hueHeightZoneLimit": "{{name}}: {{min}}–{{max}} m",
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
    fireEvent.click(screen.getByRole("button", { name: "common:hintFor" }));
    expect(screen.getByText("Sofa: 0.63–1.88 m")).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "common:hintFor" })).toBeNull();
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
