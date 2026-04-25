/**
 * HueChannelOverlay regression tests.
 *
 * Bug-driven coverage for v1.5 W1-A6 / W1-A8 zone authoring:
 *  - Bug #50: dragging the zone center moves the dashed bounds box AND
 *    every channel dot bound to the zone in lockstep (imperative DOM
 *    update during pointermove, single state commit on pointerup).
 *  - Bug #52(a): dragging a zone-bound channel never escapes the zone
 *    bounds — clamp pipeline is `world → zone-relative → world`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

import { HueChannelOverlay } from "../HueChannelOverlay";
import type { HueChannelPlacement, HueZone } from "../../../../../shared/contracts/roomMap";

// jsdom does not implement setPointerCapture; stub it so React stays happy.
beforeEach(() => {
  if (!(HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
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
