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
import React from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RoomMapEditor } from "../../RoomMapEditor";

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

vi.mock("../../../../persistence/shellStore", () => ({
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

vi.mock("../../../../device/useUsbConnectionStatus", () => ({
  useUsbConnectionStatus: () => ({ ready: false }),
}));

vi.mock("../useRoomMapPersist", () => ({
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
    },
    updateConfig: vi.fn().mockResolvedValue(undefined),
    replaceConfig: vi.fn().mockResolvedValue(undefined),
    resetConfig: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    // canUndo: true bypasses the isEmpty && !canUndo early-return to TemplateSelector
    canUndo: true,
    canRedo: false,
    loading: false,
    error: null,
  }),
}));

vi.mock("../RoomMapCanvas", () => ({
  RoomMapCanvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="room-map-canvas">{children}</div>
  ),
}));

vi.mock("../RoomMapToolbar", () => ({
  RoomMapToolbar: () => <div data-testid="room-map-toolbar" />,
}));

vi.mock("../RoomMapSettingsPopover", () => ({
  RoomMapSettingsPopover: () => null,
}));

vi.mock("../RoomMapEmptyHint", () => ({
  RoomMapEmptyHint: () => null,
}));

vi.mock("../FurnitureObject", () => ({
  FurnitureObject: () => null,
}));

vi.mock("../TvAnchorObject", () => ({
  TvAnchorObject: () => null,
}));

vi.mock("../UsbStripObject", () => ({
  UsbStripObject: () => null,
}));

vi.mock("../HueChannelOverlay", () => ({
  HueChannelOverlay: () => null,
}));

vi.mock("../RoomDockPanel", () => ({
  RoomDockPanel: () => <div data-testid="room-dock-panel" />,
}));

vi.mock("../deriveZones", () => ({
  deriveZones: vi.fn().mockReturnValue({ zones: [], warnings: [] }),
}));

vi.mock("../useSnapGuides", () => ({
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

// ---------------------------------------------------------------------------
// Preserved stub tests (Wave 0, pending implementation)
// ---------------------------------------------------------------------------

describe("RoomMapEditor (pending)", () => {
  // requires jsdom layout (offsetWidth/offsetHeight always 0 in jsdom);
  // pxPerMeter is a fixed constant (80) in production, not derived from DOM
  // measurements — ratio assertion needs a real browser environment; revisit
  // when Playwright component tests are added.
  it.todo("ROOM-01: renders canvas with room dimensions proportional to config");

  // requires coordinate-level assertion of Hue channel DOM positions relative
  // to the TV anchor; needs real getBoundingClientRect values which jsdom does
  // not compute — revisit when Playwright component tests are added.
  it.todo("ROOM-06: TV anchor acts as center reference — Hue channels positioned relative to TV");

  // ROOM-08 removed in v1.5.x — backgroundImagePath field was migrated to the
  // imageLayers system (useRoomMapPersist.ts migration at load time); the old
  // field is no longer rendered on the canvas and the assertion no longer applies.
});
