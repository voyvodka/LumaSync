/**
 * HueChannelOverlay regression tests.
 *
 * Zone authoring:
 *  - dragging the zone center moves the dashed bounds box AND every
 *    channel dot bound to the zone in lockstep (imperative DOM update
 *    during pointermove, single state commit on pointerup).
 *  - dragging a zone-bound channel never escapes the zone bounds —
 *    clamp pipeline is `world → zone-relative → world`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

import { HueChannelOverlay, pinnedZoneEdges } from "../HueChannelOverlay";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import type { SnapResult } from "../../model/snapGeometry";

beforeEach(() => {
  cleanup();
});

// Minimal i18n shim — tests only assert structural behaviour, copy is
// surfaced as `key` strings which is fine for non-visual assertions.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const ZONE: HueZone = {
  id: "zone-1",
  name: "Sofa back-light",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 0.3,
  scaleY: 0.3,
  scaleZ: 0.3,
  channelIndices: [0],
  borderColor: "#3b82f6",
};

const CHANNEL_IN_ZONE: HueChannelPlacement = {
  channelIndex: 0,
  x: 0.1,
  y: 0.1,
  z: 0,
  zoneId: "zone-1",
  zoneRelativePosition: { x: 0.33, y: 0.33, z: 0 },
};

describe("HueChannelOverlay — overhead lights", () => {
  it("rings a light that hangs overhead and says so, and leaves a standing one plain", () => {
    const { container } = render(
      <HueChannelOverlay
        channels={[
          { channelIndex: 0, x: 0, y: 0, z: 1 },
          { channelIndex: 1, x: 0.5, y: 0.5, z: -1 },
        ]}
        overhead={new Set([0])}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
      />,
    );
    const [hung, standing] = Array.from(container.querySelectorAll<HTMLElement>("[data-object-id]"));
    expect(hung.querySelector('[data-testid="hue-overhead"]')).not.toBeNull();
    expect(hung.querySelector('[role="button"]')?.getAttribute("aria-label")).toBe("roomMap:hueChannel.overheadLabel");
    expect(standing.querySelector('[data-testid="hue-overhead"]')).toBeNull();
  });
});

describe("HueChannelOverlay — names", () => {
  it("shows the selected light's name at the plan's zoom, the others' only on hover or focus", () => {
    const { container } = render(
      <HueChannelOverlay
        channels={[
          { channelIndex: 0, x: 0, y: 0, z: 0 },
          { channelIndex: 1, x: 0.5, y: 0.5, z: 0 },
        ]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={2}
        selectedId="hue-0"
        onSelect={() => {}}
        onChange={() => {}}
      />,
    );
    const [picked, other] = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="hue-name"]'));
    expect(picked).toHaveAttribute("data-shown");
    expect(other).not.toHaveAttribute("data-shown");
    expect(picked!.style.getPropertyValue("--lm-hue-name-scale")).toBe("0.5");
    expect(container.querySelector('[role="button"]')).not.toHaveAttribute("title");
  });
});

describe("HueChannelOverlay — bug #52(a) drag-time zone clamp", () => {
  it("never lets a zone-bound channel drag past the zone bounds", () => {
    const onChange = vi.fn();
    const { container } = render(
      <HueChannelOverlay
        channels={[CHANNEL_IN_ZONE]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={() => {}}
        onChange={onChange}
        activeHueZone={ZONE}
      />,
    );

    const wrapper = container.querySelector<HTMLDivElement>('[data-zone-channel-id="zone-1"]');
    expect(wrapper).toBeTruthy();
    const dot = wrapper!.querySelector<HTMLDivElement>('[role="button"]');
    expect(dot).toBeTruthy();

    // Simulate a violent drag well past the zone box (zone half-width is
    // 0.3 in Hue space → 0.3 * 2.5m = 0.75m → 60px at pxPerMeter=80).
    // We push the cursor 800px right, way beyond the zone, and assert
    // the persisted zone-relative position clamps at +1 on the X axis.
    fireEvent.pointerDown(dot!, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(dot!, { clientX: 1000, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(dot!, { clientX: 1000, clientY: 100, pointerId: 1 });

    expect(onChange).toHaveBeenCalledTimes(1);
    const updated = onChange.mock.calls[0][0] as HueChannelPlacement;
    expect(updated.zoneRelativePosition).toBeDefined();
    expect(updated.zoneRelativePosition!.x).toBeLessThanOrEqual(1);
    expect(updated.zoneRelativePosition!.x).toBeGreaterThanOrEqual(-1);
    expect(updated.zoneRelativePosition!.y).toBeLessThanOrEqual(1);
    expect(updated.zoneRelativePosition!.y).toBeGreaterThanOrEqual(-1);
    // World x must also stay inside the zone half-width.
    expect(updated.x).toBeLessThanOrEqual(ZONE.centerX + Math.abs(ZONE.scaleX) + 1e-9);
    expect(updated.x).toBeGreaterThanOrEqual(ZONE.centerX - Math.abs(ZONE.scaleX) - 1e-9);
  });
});

// A bound channel's `x`/`y` are leftovers — nothing updates them when the zone
// moves or the channel is assigned. The drag started from them, so the dot
// jumped there on the first move and the drop clamped it to the zone's edge.
describe("HueChannelOverlay — a drag starts where the dot is drawn", () => {
  it("moves a bound channel from its zone-resolved position, not its stale absolute one", () => {
    const onChange = vi.fn();
    const stale: HueChannelPlacement = {
      ...CHANNEL_IN_ZONE,
      x: -0.8,
      y: 0.9,
      zoneRelativePosition: { x: 0.5, y: 0, z: 0 },
    };
    const { container } = render(
      <HueChannelOverlay
        channels={[stale]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={() => {}}
        onChange={onChange}
        allHueZones={[ZONE]}
      />,
    );
    const dot = container.querySelector<HTMLDivElement>('[role="button"]');

    // 8 px at 80 px/m is 0.1 m, which in a 5 m room is 0.04 of the Hue cube.
    fireEvent.pointerDown(dot!, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(dot!, { clientX: 108, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(dot!, { clientX: 108, clientY: 100, pointerId: 1 });

    const updated = onChange.mock.calls[0]?.[0] as HueChannelPlacement;
    // Drawn at 0 + 0.3 * 0.5 = 0.15; one move later it is at 0.19.
    expect(updated.x).toBeCloseTo(0.19, 10);
    expect(updated.y).toBeCloseTo(0, 10);
    expect(updated.zoneRelativePosition?.x).toBeCloseTo(0.19 / 0.3, 10);
  });
});

// A click's 1–3 px wobble moved the light and wrote it back to the bridge.
describe("HueChannelOverlay — a click is not a drag", () => {
  const renderOne = () => {
    const onChange = vi.fn<(updated: HueChannelPlacement) => void>();
    const onSelect = vi.fn<(channelIndex: number) => void>();
    const { container } = render(
      <HueChannelOverlay
        channels={[{ channelIndex: 0, x: 0, y: 0, z: 0 }]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={onSelect}
        onChange={onChange}
      />,
    );
    return { onChange, onSelect, dot: container.querySelector<HTMLDivElement>('[role="button"]')! };
  };

  it("selects on a press that wobbles a few pixels, and writes nothing", () => {
    const { onChange, onSelect, dot } = renderOne();
    fireEvent.pointerDown(dot, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(dot, { clientX: 103, clientY: 102, pointerId: 1 });
    fireEvent.pointerUp(dot, { clientX: 103, clientY: 102, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("puts the light back on Esc mid-drag and writes nothing", () => {
    const { onChange, dot } = renderOne();
    const wrapper = dot.parentElement!;
    const home = { left: wrapper.style.left, top: wrapper.style.top };
    fireEvent.pointerDown(dot, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(dot, { clientX: 160, clientY: 100, pointerId: 1 });
    expect(wrapper.hasAttribute("data-dragging")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(dot, { clientX: 160, clientY: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
    expect({ left: wrapper.style.left, top: wrapper.style.top }).toEqual(home);
    expect(wrapper.hasAttribute("data-dragging")).toBe(false);
  });
});

describe("HueChannelOverlay — W4-J #3 simultaneous zone visibility", () => {
  it("renders bounds for every zone in allHueZones (passive zones besides the active one)", () => {
    const passive: HueZone = {
      id: "zone-2",
      name: "Reading nook",
      entertainmentAreaId: "area-1",
      centerX: 0.4,
      centerY: -0.4,
      centerZ: 0,
      scaleX: 0.2,
      scaleY: 0.2,
      scaleZ: 0.2,
      channelIndices: [],
      borderColor: "#a855f7",
    };
    const { container } = render(
      <HueChannelOverlay
        channels={[]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        activeHueZone={ZONE}
        allHueZones={[ZONE, passive]}
      />,
    );

    // Passive zone renders a dashed border but does NOT carry the
    // `data-zone-bounds-id` attribute (that one is reserved for the
    // active zone so the center-drag DOM lookup stays unambiguous).
    const activeBounds = container.querySelectorAll(`[data-zone-bounds-id="${ZONE.id}"]`);
    expect(activeBounds).toHaveLength(1);
    const passiveBounds = container.querySelectorAll(`[data-zone-bounds-id="${passive.id}"]`);
    expect(passiveBounds).toHaveLength(0);

    // The passive layer paints at `z-index: 17` (behind the active
    // chrome) and the active bounds paint at `z-index: 18`. happy-dom
    // silently drops `color-mix()` declarations from the inline
    // `border` shorthand, so we count layers via `z-index` instead of
    // dashed-border presence — the structural signal is enough to
    // prove both layers actually render.
    const passiveLayers = Array.from(container.querySelectorAll<HTMLDivElement>("div"))
      .filter((el) => el.style.zIndex === "17");
    expect(passiveLayers).toHaveLength(1);
    const activeLayers = Array.from(container.querySelectorAll<HTMLDivElement>("div"))
      .filter((el) => el.style.zIndex === "18");
    expect(activeLayers).toHaveLength(1);
  });

  it("omits the active zone from the passive list so it is not double-rendered", () => {
    const { container } = render(
      <HueChannelOverlay
        channels={[]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        activeHueZone={ZONE}
        allHueZones={[ZONE]}
      />,
    );
    // Only one bounds element with this zone's id should exist (the
    // active chrome). If the passive layer rendered the same zone we
    // would get two — and the center drag would attach to the wrong
    // one.
    const bounds = container.querySelectorAll(`[data-zone-bounds-id="${ZONE.id}"]`);
    expect(bounds).toHaveLength(1);
  });
});

describe("HueChannelOverlay — a zone-centre drag the zone does not outlive", () => {
  const overlay = (zone: HueZone | null, onHueZoneCenterChange = vi.fn<(id: string, x: number, y: number, held?: boolean) => void>()) => (
    <HueChannelOverlay
      channels={[]}
      pxPerMeter={80}
      roomWidthM={5}
      roomDepthM={4}
      zoom={1}
      selectedId={null}
      onSelect={() => {}}
      onChange={() => {}}
      activeHueZone={zone}
      allHueZones={zone ? [zone] : []}
      onHueZoneCenterChange={onHueZoneCenterChange}
    />
  );

  it("lets go of Escape when the zone goes away mid-drag", () => {
    const { container, rerender } = render(overlay(ZONE));
    const marker = container.querySelector(`[data-zone-center-id="${ZONE.id}"]`) as HTMLElement;
    marker.setPointerCapture = () => {};
    fireEvent.pointerDown(marker, { clientX: 100, clientY: 100, pointerId: 1 });
    rerender(overlay(null));
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
  });
});

describe("HueChannelOverlay — bug #50 + #52(b) zone center drag", () => {
  it("tags zone-bound channels with data-zone-channel-id so the center handler can move them", () => {
    const { container } = render(
      <HueChannelOverlay
        channels={[CHANNEL_IN_ZONE]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        activeHueZone={ZONE}
      />,
    );

    // Dashed bounds box exposes the zone id so the center drag can find it.
    const bounds = container.querySelector(`[data-zone-bounds-id="${ZONE.id}"]`);
    expect(bounds).toBeTruthy();

    // Bound channel dot wrapper exposes the zone id so the center drag
    // can imperatively translate it during pointermove.
    const channelWrapper = container.querySelector(`[data-zone-channel-id="${ZONE.id}"]`);
    expect(channelWrapper).toBeTruthy();
  });

  it("does not tag channels that belong to a different zone", () => {
    const stranger: HueChannelPlacement = {
      channelIndex: 1,
      x: 0.5,
      y: 0.5,
      z: 0,
      zoneId: "zone-other",
      zoneRelativePosition: { x: 0, y: 0, z: 0 },
    };
    const { container } = render(
      <HueChannelOverlay
        channels={[CHANNEL_IN_ZONE, stranger]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        zoom={1}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        activeHueZone={ZONE}
      />,
    );

    const tagged = container.querySelectorAll(`[data-zone-channel-id="${ZONE.id}"]`);
    expect(tagged).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pinned-edge cue — why a large zone's centre marker stops short of the wall
// ---------------------------------------------------------------------------

describe("pinnedZoneEdges", () => {
  it("names the wall the box is flush against, not where the marker sits", () => {
    // A 0.6-scale zone pinned at the top: the centre stops at 0.4, which is
    // 0.6 away from the wall its edge is touching. That gap is the whole reason
    // the drag looks stuck.
    expect(pinnedZoneEdges({ centerX: 0, centerY: 0.4 }, { halfScaleX: 0.6, halfScaleY: 0.6 }))
      .toBe("top");
  });

  it("lights both edges in a corner", () => {
    expect(pinnedZoneEdges({ centerX: -0.7, centerY: -0.7 }, { halfScaleX: 0.3, halfScaleY: 0.3 }))
      .toBe("bottom left");
  });

  it("says nothing while the zone still has room to move", () => {
    expect(pinnedZoneEdges({ centerX: 0, centerY: 0 }, { halfScaleX: 0.3, halfScaleY: 0.3 }))
      .toBe("");
  });

  it("reports nothing for a degenerate zone that already overflows the cube", () => {
    // Centre chosen so the arithmetic *would* match without the half-scale
    // guard: at 1.4, `-1 + halfScale` is 0.4 on both axes, so a guardless
    // version answers "bottom left" and lights a box that is already outside
    // the room. A centred probe passes either way and proves nothing.
    expect(pinnedZoneEdges({ centerX: 0.4, centerY: 0.4 }, { halfScaleX: 1.4, halfScaleY: 1.4 }))
      .toBe("");
  });

  it("pins a full-width zone that can only sit centred", () => {
    expect(pinnedZoneEdges({ centerX: 0, centerY: 0 }, { halfScaleX: 1, halfScaleY: 1 }))
      .toBe("top bottom left right");
  });
});

describe("HueChannelOverlay — keyboard", () => {
  const renderWithZone = (
    zone: HueZone,
    onEditorKey = vi.fn<() => void>(),
    onHueZoneCenterChange = vi.fn<(id: string, x: number, y: number) => void>(),
  ) => {
    // The editor's key handler sits on an ancestor, as it does in RoomMapEditor.
    const view = render(
      <div onKeyDown={onEditorKey}>
        <HueChannelOverlay
          channels={[CHANNEL_IN_ZONE, { channelIndex: 1, x: -0.8, y: -0.8, z: 0 }]}
          pxPerMeter={80}
          roomWidthM={5}
          roomDepthM={4}
          zoom={1}
          selectedId={null}
          onSelect={() => {}}
          onChange={() => {}}
          activeHueZone={zone}
          onHueZoneCenterChange={onHueZoneCenterChange}
        />
      </div>,
    );
    const marker = view.getByRole("button", { name: "roomMap:hueZones.centerMarkerAriaLabel" });
    return { ...view, marker, onHueZoneCenterChange };
  };

  it("moves the zone centre with the arrow keys, Up toward the TV wall", () => {
    const { marker, onHueZoneCenterChange } = renderWithZone(ZONE);

    fireEvent.keyDown(marker, { key: "ArrowRight" });
    expect(onHueZoneCenterChange).toHaveBeenLastCalledWith("zone-1", 0.05, 0, true);

    fireEvent.keyDown(marker, { key: "ArrowUp", shiftKey: true });
    expect(onHueZoneCenterChange).toHaveBeenLastCalledWith("zone-1", 0, 0.2, true);
  });

  it("keeps the zone box inside the cube and stops the editor's own arrow handling", () => {
    const onEditorKey = vi.fn<() => void>();
    const { marker, onHueZoneCenterChange } = renderWithZone({ ...ZONE, centerX: 0.7 }, onEditorKey);

    fireEvent.keyDown(marker, { key: "ArrowRight" });

    expect(onHueZoneCenterChange).not.toHaveBeenCalled();
    expect(onEditorKey).not.toHaveBeenCalled();
  });

  it("keeps a dot dimmed by the active zone out of the tab order", () => {
    const { getAllByRole } = renderWithZone(ZONE);
    const dots = getAllByRole("button").filter((el) => el.hasAttribute("aria-pressed"));

    expect(dots.map((dot) => dot.tabIndex)).toEqual([0, -1]);
    expect(dots[1]).toHaveAttribute("aria-disabled", "true");
  });
});

describe("HueChannelOverlay — zone grips", () => {
  // 5×4 m at 100 px a metre: the zone is x 1.75–3.25 m, y 1.4–2.6 m.
  function renderGrips(zone: HueZone = ZONE) {
    const onHueZoneResize = vi.fn<(zoneId: string, footprint: Pick<HueZone, "centerX" | "centerY" | "scaleX" | "scaleY">) => void>();
    const view = render(
      <HueChannelOverlay
        channels={[CHANNEL_IN_ZONE]}
        pxPerMeter={100}
        roomWidthM={5}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        activeHueZone={zone}
        allHueZones={[zone]}
        onHueZoneResize={onHueZoneResize}
      />,
    );
    const grip = (handle: string) => {
      const el = view.container.querySelector<HTMLElement>(`[data-zone-handle="${handle}"]`)!;
      el.setPointerCapture = () => {};
      return el;
    };
    const box = view.container.querySelector<HTMLElement>('[data-zone-bounds-id="zone-1"]')!;
    const light = view.container.querySelector<HTMLElement>('[data-zone-channel-id="zone-1"]')!;
    return { onHueZoneResize, grip, box, light };
  }

  it("reshapes the box and its lights while dragged and writes the zone once on release", () => {
    const { onHueZoneResize, grip, box, light } = renderGrips();
    const se = grip("se");
    const lightLeft = parseFloat(light.style.left);
    fireEvent.pointerDown(se, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(se, { clientX: 150, clientY: 60, pointerId: 1 });
    expect(parseFloat(box.style.width)).toBeCloseTo(300);
    expect(parseFloat(box.style.height)).toBeCloseTo(180);
    // The light keeps its place relative to the zone, which grew right from its west wall.
    expect(parseFloat(light.style.left)).toBeCloseTo(175 + ((lightLeft - 175) / 150) * 300);
    expect(onHueZoneResize).not.toHaveBeenCalled();
    fireEvent.pointerUp(se, { pointerId: 1 });
    expect(onHueZoneResize).toHaveBeenCalledTimes(1);
    const [id, footprint] = onHueZoneResize.mock.calls[0]!;
    expect(id).toBe("zone-1");
    expect(footprint.scaleX).toBeCloseTo(0.6);
    expect(footprint.scaleY).toBeCloseTo(0.45);
    expect(footprint.centerX).toBeCloseTo(0.3);
    expect(footprint.centerY).toBeCloseTo(-0.15);
  });

  it("drops a side's middle grip when the side is too short to hold three", () => {
    // 0.6 m wide, 1.2 m deep: 60 px and 120 px on screen.
    renderGrips({ ...ZONE, scaleX: 0.12, scaleY: 0.3 });
    const handles = Array.from(document.querySelectorAll<HTMLElement>("[data-zone-handle]")).map((el) => el.dataset.zoneHandle);
    expect(handles.sort()).toEqual(["e", "ne", "nw", "se", "sw", "w"]);
  });

  it("puts everything back on Escape and writes nothing", () => {
    const { onHueZoneResize, grip, box } = renderGrips();
    const w = grip("w");
    const before = box.style.cssText;
    fireEvent.pointerDown(w, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(w, { clientX: -80, clientY: 0, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(w, { pointerId: 1 });
    expect(box.style.cssText).toBe(before);
    expect(onHueZoneResize).not.toHaveBeenCalled();
  });

  it("lets go of Escape when the grips go away mid-drag", () => {
    const view = render(
      <HueChannelOverlay
        channels={[CHANNEL_IN_ZONE]}
        pxPerMeter={100}
        roomWidthM={5}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        activeHueZone={ZONE}
        allHueZones={[ZONE]}
        onHueZoneResize={() => {}}
      />,
    );
    const se = view.container.querySelector<HTMLElement>('[data-zone-handle="se"]')!;
    se.setPointerCapture = () => {};
    fireEvent.pointerDown(se, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(se, { clientX: 80, clientY: 0, pointerId: 1 });
    view.unmount();
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
  });
});

describe("HueChannelOverlay — guides", () => {
  function renderLight(onSnapDragMove: (id: string, x: number, y: number, w: number, h: number) => SnapResult) {
    const onChange = vi.fn<(ch: HueChannelPlacement) => void>();
    const onSnapDragEnd = vi.fn<() => void>();
    const view = render(
      <HueChannelOverlay
        channels={[{ channelIndex: 0, x: 0, y: 0, z: 0 }]}
        pxPerMeter={100}
        roomWidthM={4}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={onChange}
        onSnapDragMove={onSnapDragMove}
        onSnapDragEnd={onSnapDragEnd}
      />,
    );
    const dot = view.container.querySelector<HTMLElement>('[data-object-id="hue-0"] [role="button"]')!;
    dot.setPointerCapture = () => {};
    dot.releasePointerCapture = () => {};
    return { dot, onChange, onSnapDragEnd };
  }

  it("asks where the light lands in plan metres and holds it on the guide it meets", () => {
    const onSnapDragMove = vi.fn<(id: string, x: number, y: number, w: number, h: number) => SnapResult>(() => ({ snapX: 3, snapY: null, guides: [] }));
    const { dot, onChange, onSnapDragEnd } = renderLight(onSnapDragMove);
    fireEvent.pointerDown(dot, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(dot, { clientX: 90, clientY: 50, pointerId: 1 });
    expect(onSnapDragMove).toHaveBeenLastCalledWith("hue-0", 2.9, 2.5, 0, 0);
    fireEvent.pointerUp(dot, { pointerId: 1 });
    // x held at 3 m of 4 → 0.5 in the cube; y follows the pointer, 0.5 m toward the back.
    expect(onChange.mock.calls[0]![0].x).toBeCloseTo(0.5);
    expect(onChange.mock.calls[0]![0].y).toBeCloseTo(-0.25);
    expect(onSnapDragEnd).toHaveBeenCalledTimes(1);
  });

  it("lets ⌥ drag a light past a guide", () => {
    const { dot, onChange } = renderLight(() => ({ snapX: 3, snapY: null, guides: [] }));
    fireEvent.pointerDown(dot, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(dot, { clientX: 90, clientY: 0, altKey: true, pointerId: 1 });
    fireEvent.pointerUp(dot, { pointerId: 1 });
    expect(onChange.mock.calls[0]![0].x).toBeCloseTo(0.45);
  });

  it("asks from the zone's edge and lets a guide beyond it go", () => {
    const onSnapDragMove = vi.fn<(id: string, x: number, y: number, w: number, h: number) => SnapResult>(() => ({ snapX: 3, snapY: null, guides: [] }));
    const onSnapDragEnd = vi.fn<() => void>();
    const onChange = vi.fn<(ch: HueChannelPlacement) => void>();
    const view = render(
      <HueChannelOverlay
        channels={[CHANNEL_IN_ZONE]}
        pxPerMeter={100}
        roomWidthM={4}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={onChange}
        activeHueZone={ZONE}
        allHueZones={[ZONE]}
        onSnapDragMove={onSnapDragMove}
        onSnapDragEnd={onSnapDragEnd}
      />,
    );
    const dot = view.container.querySelector<HTMLElement>('[data-zone-channel-id="zone-1"] [role="button"]')!;
    dot.setPointerCapture = () => {};
    dot.releasePointerCapture = () => {};
    fireEvent.pointerDown(dot, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(dot, { clientX: 400, clientY: 0, pointerId: 1 });
    // The zone ends at 0.3 in the cube, 2.6 m of 4; the guide at 3 m lies outside it.
    expect(onSnapDragMove.mock.lastCall![1]).toBeCloseTo(2.6);
    expect(onSnapDragEnd).toHaveBeenCalled();
    fireEvent.pointerUp(dot, { pointerId: 1 });
    expect(onChange.mock.calls[0]![0].x).toBeCloseTo(0.3);
  });
});

describe("HueChannelOverlay — lit lights", () => {
  it("haloes each light in the lights' colour while they are on, and not one the bridge lost", () => {
    const { container } = render(
      <HueChannelOverlay
        channels={[
          { channelIndex: 0, channelId: 0, x: 0, y: 0, z: 0 },
          { channelIndex: 1, channelId: 9, x: 0.5, y: 0.5, z: 0 },
        ]}
        liveChannelIds={new Set([0])}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
        glow={{ colour: "#ff8800", level: 1 }}
      />,
    );
    const lit = container.querySelector<HTMLElement>('[data-object-id="hue-0"]')!;
    const lost = container.querySelector<HTMLElement>('[data-object-id="hue-1"]')!;
    expect(lit).toHaveAttribute("data-lit");
    expect(lit.querySelector<HTMLElement>('[role="button"]')!.style.boxShadow).toContain("#ff8800");
    expect(lost).not.toHaveAttribute("data-lit");
  });

  it("draws no halo while the lights are off", () => {
    const { container } = render(
      <HueChannelOverlay
        channels={[{ channelIndex: 0, x: 0, y: 0, z: 0 }]}
        pxPerMeter={80}
        roomWidthM={5}
        roomDepthM={4}
        selectedId={null}
        onSelect={() => {}}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector('[data-object-id="hue-0"]')).not.toHaveAttribute("data-lit");
  });
});
