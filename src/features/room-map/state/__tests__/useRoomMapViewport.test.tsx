// Guards fit-to-view: the canvas container is absent from the first commit
// (RoomMapEditor shows a placeholder while the map loads), so the observer must
// attach when the element appears — yet the fit stays one-shot and first-render.
import { useState } from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RoomDimensions } from "@/shared/contracts/roomMap";

import { useRoomMapViewport, ROOM_MAP_PX_PER_METER } from "../useRoomMapViewport";
import type { UseRoomMapViewportReturn } from "../useRoomMapViewport";

// happy-dom has no layout engine, so a real ResizeObserver would never report a
// non-zero contentRect. Measurements are injected through `emit` instead.
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    StubResizeObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }

  emit(width: number, height: number) {
    this.callback(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

let viewport: UseRoomMapViewportReturn;

function Harness({ loading, dimensions }: { loading: boolean; dimensions: RoomDimensions }) {
  viewport = useRoomMapViewport(dimensions);
  if (loading) return <div data-testid="placeholder">Loading...</div>;
  return <div data-testid="canvas" ref={viewport.setCanvasContainer} />;
}

const ROOM_5X4: RoomDimensions = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };

/** Canvas 800x600, room 5x4m, pad 24 → zoom 1.725, room 690x552, centred at 55/24. */
const FITTED_ZOOM = 1.725;

describe("useRoomMapViewport", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    StubResizeObserver.instances = [];
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });

  it("observes a canvas container that only appears after the first render", () => {
    const { rerender, getByTestId } = render(<Harness loading dimensions={ROOM_5X4} />);

    rerender(<Harness loading={false} dimensions={ROOM_5X4} />);

    const container = getByTestId("canvas");
    const observed = StubResizeObserver.instances.flatMap((ro) => ro.observed);
    expect(observed).toContain(container);
    // MouseCoordinateDisplay reads the element through the ref object.
    expect(viewport.canvasContainerRef.current).toBe(container);
  });

  it("fits the room to the view on the first measurement", () => {
    const { rerender } = render(<Harness loading dimensions={ROOM_5X4} />);
    rerender(<Harness loading={false} dimensions={ROOM_5X4} />);

    act(() => {
      for (const ro of StubResizeObserver.instances) ro.emit(800, 600);
    });

    expect(viewport.canvasSize).toEqual({ w: 800, h: 600 });
    expect(viewport.zoom).toBeCloseTo(FITTED_ZOOM, 5);
    expect(viewport.panOffset.x).toBeCloseTo(55, 5);
    expect(viewport.panOffset.y).toBeCloseTo(24, 5);
  });

  it("stays one-shot — a later resize does not re-fit the view the user moved", () => {
    const { rerender } = render(<Harness loading dimensions={ROOM_5X4} />);
    rerender(<Harness loading={false} dimensions={ROOM_5X4} />);

    act(() => {
      for (const ro of StubResizeObserver.instances) ro.emit(800, 600);
    });
    act(() => {
      viewport.setZoom(2);
      viewport.setPanOffset({ x: 10, y: 10 });
    });
    act(() => {
      for (const ro of StubResizeObserver.instances) ro.emit(1000, 900);
    });

    expect(viewport.canvasSize).toEqual({ w: 1000, h: 900 });
    expect(viewport.zoom).toBe(2);
    expect(viewport.panOffset).toEqual({ x: 10, y: 10 });
  });

  it("fits with the dimensions the editor started with, not a later value", () => {
    const { rerender } = render(<Harness loading dimensions={ROOM_5X4} />);
    // A dimension change arriving before the container mounts must not become
    // the basis of the fit — the room the user opened is the one framed.
    rerender(<Harness loading dimensions={{ widthMeters: 10, depthMeters: 8, heightMeters: 2.5 }} />);
    rerender(<Harness loading={false} dimensions={{ widthMeters: 10, depthMeters: 8, heightMeters: 2.5 }} />);

    act(() => {
      for (const ro of StubResizeObserver.instances) ro.emit(800, 600);
    });

    expect(viewport.zoom).toBeCloseTo(FITTED_ZOOM, 5);
  });

  it("disconnects the observer on unmount", () => {
    const { rerender, unmount } = render(<Harness loading dimensions={ROOM_5X4} />);
    rerender(<Harness loading={false} dimensions={ROOM_5X4} />);

    const attached = StubResizeObserver.instances.filter((ro) => ro.observed.length > 0);
    expect(attached.length).toBeGreaterThan(0);

    unmount();

    expect(attached.every((ro) => ro.disconnected)).toBe(true);
  });

  it("exposes a fixed physical scale", () => {
    expect(ROOM_MAP_PX_PER_METER).toBe(80);
  });

  it("re-observes when the container element is swapped", () => {
    function SwapHarness() {
      const [key, setKey] = useState(0);
      viewport = useRoomMapViewport(ROOM_5X4);
      return (
        <>
          <div key={key} data-testid={`canvas-${key}`} ref={viewport.setCanvasContainer} />
          <button type="button" onClick={() => setKey(1)}>
            swap
          </button>
        </>
      );
    }

    const { getByRole, getByTestId } = render(<SwapHarness />);
    act(() => {
      getByRole("button").click();
    });

    const observed = StubResizeObserver.instances.flatMap((ro) => ro.observed);
    expect(observed).toContain(getByTestId("canvas-1"));
  });
});
