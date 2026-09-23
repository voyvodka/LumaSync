/**
 * RoomMapEditor — F8 regression tests
 *
 * Covers the mousemove handler stability fix from commit fe351c2:
 * "fix(ui): prevent event listener thrashing in RoomMapEditor mousemove handler"
 *
 * The perf fix moved mousemove + mouseleave handlers into a stable useEffect
 * (deps: [canvasContainerRef]) inside the MouseCoordinateDisplay sub-component,
 * replacing the previous pattern that added/removed the listener on every render.
 *
 * Previously existing stub tests are preserved at the bottom.
 */
import type React from "react";
import { render, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RoomMapEditor } from "../RoomMapEditor";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({
      roomMap: null,
      roomMapShowGrid: true,
      roomMapGridStrokeWidth: 0.5,
      roomMapShowHueZones: true,
    }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/features/device/useUsbConnectionStatus", () => ({
  useUsbConnectionStatus: () => ({ ready: false }),
}));

// Mutable so a test can start the editor in its loading state and flip it.
const persistState = vi.hoisted(() => ({
  loading: false,
  configOverride: {} as Record<string, unknown>,
  updateConfig: vi.fn().mockResolvedValue(undefined),
  undo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../state/useRoomMapPersist", () => ({
  useRoomMapPersist: () => ({
    config: {
      dimensions: { widthMeters: 5, depthMeters: 4 },
      furniture: [],
      // tvAnchor non-null so isEmpty = false → main canvas div renders
      tvAnchor: { x: 0, y: 0, widthMeters: 1, depthMeters: 0.1, label: "TV" },
      usbStrips: [],
      hueChannels: [],
      hueZones: [],
      // zones needed by hueZones = config.zones references
      zones: [],
      backgroundImagePath: null,
      imageLayers: [],
      ...persistState.configOverride,
    },
    updateConfig: persistState.updateConfig,
    replaceConfig: vi.fn().mockResolvedValue(undefined),
    resetConfig: vi.fn().mockResolvedValue(undefined),
    undo: persistState.undo,
    redo: vi.fn().mockResolvedValue(undefined),
    // canUndo: true bypasses the isEmpty && !canUndo early-return to TemplateSelector
    canUndo: true,
    canRedo: false,
    loading: persistState.loading,
    error: null,
  }),
}));

vi.mock("../RoomMapCanvas", () => ({
  RoomMapCanvas: ({
    children,
    panOffset,
    panMode,
  }: {
    children?: React.ReactNode;
    panOffset: { x: number; y: number };
    panMode?: boolean;
  }) => (
    <div
      data-testid="room-map-canvas"
      data-pan-x={panOffset.x}
      data-pan-y={panOffset.y}
      data-pan-mode={String(Boolean(panMode))}
    >
      {children}
    </div>
  ),
}));

vi.mock("../RoomMapToolbar", () => ({
  RoomMapToolbar: ({ onToggleSettings }: { onToggleSettings: () => void }) => (
    <div data-testid="room-map-toolbar">
      <button type="button" data-testid="toggle-settings" onClick={onToggleSettings} />
    </div>
  ),
}));

vi.mock("../RoomMapSettingsPopover", () => ({
  RoomMapSettingsPopover: ({
    dimensions,
    onDimensionsChange,
  }: {
    dimensions: { widthMeters: number; depthMeters: number; heightMeters: number };
    onDimensionsChange: (d: { widthMeters: number; depthMeters: number; heightMeters: number }) => void;
  }) => (
    <button
      type="button"
      data-testid="grow-room"
      onClick={() => onDimensionsChange({ ...dimensions, widthMeters: 7, depthMeters: 6 })}
    />
  ),
}));

vi.mock("../RoomMapEmptyHint", () => ({
  RoomMapEmptyHint: () => null,
}));

vi.mock("../objects/FurnitureObject", () => ({
  FurnitureObject: () => null,
}));

vi.mock("../objects/TvAnchorObject", () => ({
  TvAnchorObject: ({ onSelect }: { onSelect: () => void }) => (
    <button type="button" data-testid="select-tv" onClick={onSelect} />
  ),
}));

vi.mock("../objects/UsbStripObject", () => ({
  UsbStripObject: () => null,
}));

vi.mock("../HueChannelOverlay", () => ({
  HueChannelOverlay: () => null,
}));

vi.mock("../RoomDockPanel", () => ({
  // A real field inside the editor root, standing in for the dock inspector's.
  RoomDockPanel: () => (
    <div data-testid="room-dock-panel">
      <input data-testid="dock-field" type="number" defaultValue={60} />
    </div>
  ),
}));

vi.mock("../../model/deriveZones", () => ({
  deriveZones: vi.fn().mockReturnValue({ zones: [], warnings: [] }),
}));

vi.mock("../../state/useSnapGuides", () => ({
  useSnapGuides: () => [],
}));

vi.mock("../SnapGuideOverlay", () => ({
  SnapGuideOverlay: () => null,
}));

vi.mock("../OriginMarker", () => ({
  OriginMarker: () => null,
}));

vi.mock("../ContextMenu", () => ({
  ContextMenu: () => null,
}));

vi.mock("../LeftToolbar", () => ({
  LeftToolbar: () => <div data-testid="left-toolbar" />,
}));

vi.mock("../PropertyBar", () => ({
  PropertyBar: () => null,
}));

vi.mock("../TemplateSelector", () => ({
  TemplateSelector: () => null,
}));

vi.mock("../ZoneDeriveOverlay", () => ({
  ZoneDeriveOverlay: () => null,
}));

// ---------------------------------------------------------------------------
// Fit-to-view wiring
// ---------------------------------------------------------------------------

describe("RoomMapEditor — canvas container observation", () => {
  // happy-dom has no layout engine, so the observer is stubbed; this proves the
  // element is handed over, not that a real measurement arrives.
  class StubResizeObserver {
    static observed: Element[] = [];
    constructor(_cb: ResizeObserverCallback) {}
    observe(el: Element) {
      StubResizeObserver.observed.push(el);
    }
    unobserve() {}
    disconnect() {}
  }

  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    StubResizeObserver.observed = [];
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
    persistState.loading = false;
  });

  it("observes the canvas container that appears once the stored map has loaded", async () => {
    persistState.loading = true;
    const { rerender, container } = render(<RoomMapEditor />);

    expect(StubResizeObserver.observed).toHaveLength(0);

    persistState.loading = false;
    await act(async () => {
      rerender(<RoomMapEditor />);
    });

    // The container div is the one MouseCoordinateDisplay measures against.
    const canvasContainer = container.querySelector(".relative.flex-1");
    expect(canvasContainer).not.toBeNull();
    expect(StubResizeObserver.observed).toContain(canvasContainer);
  });
});

// ---------------------------------------------------------------------------
// F8 — MouseCoordinateDisplay event-listener stability tests
// ---------------------------------------------------------------------------

describe("RoomMapEditor — MouseCoordinateDisplay event-listener stability (F8)", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on HTMLDivElement prototype so we capture calls on the canvas
    // container div (the one with ref={canvasContainerRef}) that
    // MouseCoordinateDisplay's useEffect attaches its handlers to.
    addEventListenerSpy = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    removeEventListenerSpy = vi.spyOn(HTMLDivElement.prototype, "removeEventListener");
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("stable handler invariant: mousemove listener count does not grow across re-renders", async () => {
    const { rerender } = render(<RoomMapEditor />);

    const countAfterMount = addEventListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "mousemove"
    ).length;

    // Three re-renders with prop changes. canvasContainerRef is stable across
    // re-renders (same underlying DOM node), so the useEffect in
    // MouseCoordinateDisplay must not fire again and must not register additional
    // listeners. If thrashing is re-introduced, each rerender would bump the count.
    await act(async () => {
      rerender(<RoomMapEditor hueReachable={true} />);
      rerender(<RoomMapEditor hueReachable={false} />);
      rerender(<RoomMapEditor hueReachable={true} />);
    });

    const countAfterRerenders = addEventListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "mousemove"
    ).length;

    expect(countAfterRerenders).toBe(countAfterMount);
  });

  it("cleanup on unmount: mousemove listener removed exactly once", async () => {
    const { unmount } = render(<RoomMapEditor />);

    const removalsBeforeUnmount = removeEventListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "mousemove"
    ).length;

    act(() => { unmount(); });

    const removalsAfterUnmount = removeEventListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "mousemove"
    ).length;

    // One removal = clean teardown. Zero = leaked. >1 = thrashing re-introduced.
    expect(removalsAfterUnmount - removalsBeforeUnmount).toBe(1);
  });

  it("mouseleave listener added and removed symmetrically with mousemove", async () => {
    const { unmount } = render(<RoomMapEditor />);

    const addedCount = addEventListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "mouseleave",
    ).length;

    act(() => { unmount(); });

    const removedCount = removeEventListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === "mouseleave",
    ).length;

    expect(addedCount).toBeGreaterThanOrEqual(1);
    expect(removedCount).toBe(addedCount);
  });
});

// Wave 0 stubs resolved where the decisions are actually made: ROOM-01 by
// `computeFit` (useRoomMapViewport.test.ts), ROOM-06 by `deriveZones`
// (deriveZones.test.ts). ROOM-08 dropped with `backgroundImagePath` in v1.5.x.

// ---------------------------------------------------------------------------
// Arrow-key viewport panning
// ---------------------------------------------------------------------------

describe("RoomMapEditor — arrow keys route to pan or nudge by selection", () => {
  class StubResizeObserver {
    constructor(_cb: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });

  /** The editor root owns `onKeyDown`; it is the outermost div React renders. */
  function renderEditor() {
    const { container } = render(<RoomMapEditor />);
    const root = container.firstElementChild as HTMLElement;
    const canvas = () => container.querySelector('[data-testid="room-map-canvas"]') as HTMLElement;
    return { container, root, canvas };
  }

  it("pans the viewport when nothing is selected", () => {
    const { root, canvas } = renderEditor();
    const before = Number(canvas().dataset.panX);

    act(() => {
      fireEvent.keyDown(root, { key: "ArrowRight" });
    });

    expect(Number(canvas().dataset.panX)).toBeLessThan(before);
  });

  it("pans vertically too, so every direction has a keyboard path", () => {
    const { root, canvas } = renderEditor();
    const before = Number(canvas().dataset.panY);

    act(() => {
      fireEvent.keyDown(root, { key: "ArrowDown" });
    });

    expect(Number(canvas().dataset.panY)).toBeLessThan(before);
  });

  it("nudges the selected object instead of panning, so selection still wins", () => {
    const { root, canvas, container } = renderEditor();

    act(() => {
      (container.querySelector('[data-testid="select-tv"]') as HTMLElement).click();
    });

    const before = Number(canvas().dataset.panX);
    act(() => {
      fireEvent.keyDown(root, { key: "ArrowRight" });
    });

    expect(Number(canvas().dataset.panX)).toBe(before);
  });

  it("says when it has the keys, instead of suppressing the ring and stopping there", () => {
    // The root routes every shortcut, and since arrows started panning the
    // viewport it is also what a keyboard user must be on for panning to work
    // at all. It shipped with `outline: none` and nothing in its place.
    const { root } = renderEditor();

    expect(root).toHaveClass("lm-room-editor");
    expect(root).toHaveAttribute("tabindex", "0");
    // The inline suppression is gone: it now lives in one rule beside the
    // replacement, so the next edit cannot reinstate a bare `none`.
    expect(root.style.outline).toBe("");
  });
});

class StubResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

// ---------------------------------------------------------------------------
// Keys typed into a field stay in the field
// ---------------------------------------------------------------------------

describe("RoomMapEditor — editor shortcuts stand aside for form fields", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
    persistState.updateConfig.mockClear();
    persistState.undo.mockClear();
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });

  function renderWithTvSelected() {
    const { container, getByTestId } = render(<RoomMapEditor />);
    act(() => {
      getByTestId("select-tv").click();
    });
    return {
      root: container.firstElementChild as HTMLElement,
      field: getByTestId("dock-field"),
      getByTestId,
    };
  }

  it("does not delete the selected object on Backspace inside a field", () => {
    const { field } = renderWithTvSelected();

    act(() => {
      fireEvent.keyDown(field, { key: "Backspace" });
    });

    expect(persistState.updateConfig).not.toHaveBeenCalledWith({ tvAnchor: undefined });
  });

  it("still deletes the selected object on Backspace outside a field", () => {
    const { root } = renderWithTvSelected();

    act(() => {
      fireEvent.keyDown(root, { key: "Backspace" });
    });

    expect(persistState.updateConfig).toHaveBeenCalledWith({ tvAnchor: undefined });
  });

  it("leaves Cmd+Z inside a field to the field's own undo", () => {
    const { field } = renderWithTvSelected();

    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(field, { key: "z", metaKey: true });
    });

    expect(persistState.undo).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("does not enter pan mode for a space typed into a field", () => {
    const { field, getByTestId } = renderWithTvSelected();

    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(field, { key: " " });
    });

    expect(getByTestId("room-map-canvas").dataset.panMode).toBe("false");
    expect(notPrevented).toBe(true);
  });

  it("enters pan mode for a space outside a field", () => {
    const { root, getByTestId } = renderWithTvSelected();

    act(() => {
      fireEvent.keyDown(root, { key: " " });
    });

    expect(getByTestId("room-map-canvas").dataset.panMode).toBe("true");
    act(() => {
      fireEvent.keyUp(root, { key: " " });
    });
  });
});

// ---------------------------------------------------------------------------
// Room resize
// ---------------------------------------------------------------------------

describe("RoomMapEditor — resizing the room", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
    persistState.updateConfig.mockClear();
    persistState.configOverride = {
      furniture: [{ id: "sofa", type: "sofa", x: 1, y: 2, width: 2, height: 0.8 }],
      hueChannels: [{ channelIndex: 0, x: 0.5, y: -0.5, z: 0 }],
    };
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
    persistState.configOverride = {};
  });

  it("keeps Hue channels in the bridge's cube while metre objects shift with the centre", () => {
    const { getByTestId } = render(<RoomMapEditor />);

    act(() => {
      getByTestId("toggle-settings").click();
    });
    act(() => {
      getByTestId("grow-room").click();
    });

    // 5 x 4 -> 7 x 6 shifts metre objects by half the growth, (1, 1).
    const calls = persistState.updateConfig.mock.calls;
    const patch = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(patch.dimensions).toMatchObject({ widthMeters: 7, depthMeters: 6 });
    expect(patch.furniture).toEqual([expect.objectContaining({ x: 2, y: 3 })]);
    // Channels are fractions of the room and follow it with no write; adding
    // the metre shift once pushed x from 0.5 to 1.5, outside [-1, 1].
    expect(patch).not.toHaveProperty("hueChannels");
  });
});
