/**
 * RoomMapEditor — the plan face: keys, the dock stand-in, room resizing and what an edit saves.
 */
import type React from "react";
import { render, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { __resetEditStage } from "../RoomMapEditor";
import { __resetRoomViewFailure, RoomMapSurface, type RoomMapSurfaceProps } from "../RoomMapSurface";

// The editor on the surface that owns its map; the 3D face and its switch are RoomMapSurface's tests.
const RoomMapEditor = (props: Omit<RoomMapSurfaceProps, "view3dAvailable">) => (
  <RoomMapSurface view3dAvailable={false} {...props} />
);

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
    onSaved: () => () => {},
    load: vi.fn().mockResolvedValue({
      roomMap: null,
      roomMapShowGrid: true,
      roomMapGridStrokeWidth: 0.5,
      roomMapShowHueZones: true,
    }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/features/device/state/localOutputsStore", () => ({
  // Not read yet: the strips' chips read "unknown".
  useLocalOutputs: <S,>(select: (state: { snapshot: null; lastLoss: null }) => S) => select({ snapshot: null, lastLoss: null }),
}));

// Mutable so a test can start the editor in its loading state and flip it.
const persistState = vi.hoisted(() => ({
  loading: false,
  configOverride: {} as Record<string, unknown>,
  apply: vi.fn(),
  undo: vi.fn(),
  replace: vi.fn<(config: unknown) => void>(),
}));

const TEMPLATE = vi.hoisted(() => ({
  dimensions: { widthMeters: 12, depthMeters: 8, heightMeters: 2.6 },
  furniture: [
    { id: "a", type: "sofa", x: 1, y: 1, width: 2, height: 0.9 },
    { id: "b", type: "bed", x: 5, y: 3, width: 1.6, height: 2 },
  ],
  usbStrips: [],
  hueChannels: [],
  zones: [],
  imageLayers: [],
}));

vi.mock("../../state/useRoomMapState", async () => {
  const { useState } = await import("react");
  return {
    useRoomMapState: () => {
      // Selection is real state, as it is in the reducer, so a click on the TV
      // stub re-renders the editor with the TV selected.
      const [selectedId, select] = useState<string | null>(null);
      const [activeHueZoneId, selectHueZone] = useState<string | null>(null);
      return {
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
        selectedId,
        activeHueZoneId,
        apply: persistState.apply,
        adopt: vi.fn(),
        replace: persistState.replace,
        reset: vi.fn(),
        undo: persistState.undo,
        redo: vi.fn(),
        select,
        selectHueZone,
        clearSelection: () => {
          select(null);
          selectHueZone(null);
        },
        // canUndo: true bypasses the isEmpty && !canUndo early-return to TemplateSelector
        canUndo: true,
        canRedo: false,
        loading: persistState.loading,
        error: null,
      };
    },
  };
});

vi.mock("../RoomMapCanvas", () => ({
  RoomMapCanvas: ({
    children,
    panOffset,
    panMode,
    onCanvasClick,
  }: {
    children?: React.ReactNode;
    panOffset: { x: number; y: number };
    panMode?: boolean;
    onCanvasClick: () => void;
  }) => (
    <div
      data-testid="room-map-canvas"
      data-room-map-viewport=""
      data-pan-x={panOffset.x}
      data-pan-y={panOffset.y}
      data-pan-mode={String(Boolean(panMode))}
    >
      <button type="button" data-testid="empty-ground" onClick={onCanvasClick} />
      {children}
    </div>
  ),
}));

vi.mock("../objects/FurnitureObject", () => ({
  FurnitureObject: ({ placement, grouped, onSelect }: { placement: { id: string }; grouped: boolean; onSelect: (id: string, additive: boolean) => void }) => (
    <i data-testid="plan-piece" data-piece={placement.id} data-grouped={grouped || undefined} onClick={() => onSelect(placement.id, true)} />
  ),
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

vi.mock("../dock/RoomDock", () => ({
  // A real field and a control inside the editor root, standing in for the dock's, and stand-ins
  // for the inspector's width field on the first piece and the room panel's size fields.
  RoomDock: ({
    config,
    actions,
    add,
    room,
    selectedId,
    activeHueZoneId,
    onSelectZone,
    onSelect,
    templates,
  }: {
    templates?: { onPreview: (template: unknown) => void; onApply: (template: unknown) => void };
    onSelect: (id: string) => void;
    add: { onAddZone: (keyboard: boolean) => void };
    selectedId: string | null;
    activeHueZoneId: string | null;
    onSelectZone: (zoneId: string) => void;
    config: { furniture: Array<{ id: string }> };
    actions: { onUpdateFurniture: (id: string, patch: Record<string, unknown>) => void };
    room: {
      dimensions: { widthMeters: number; depthMeters: number; heightMeters: number };
      onDimensionsChange: (d: { widthMeters: number; depthMeters: number; heightMeters: number }) => void;
    };
  }) => (
    <section
      data-testid="room-dock"
      data-room-dock=""
      data-selected={selectedId ?? ""}
      data-zone={activeHueZoneId ?? ""}
      data-furniture={config.furniture.length}
    >
      <button type="button" data-testid="preview-template" onClick={() => templates?.onPreview(TEMPLATE)} />
      <button type="button" data-testid="leave-template" onClick={() => templates?.onPreview(null)} />
      <button type="button" data-testid="apply-template" onClick={() => templates?.onApply(TEMPLATE)} />
      <button type="button" data-testid="dock-tab" />
      <button type="button" data-testid="pick-zone" onClick={() => onSelectZone("zone-1")} />
      <button type="button" data-testid="add-zone" onClick={() => add.onAddZone(false)} />
      <button type="button" data-testid="add-zone-key" onClick={() => add.onAddZone(true)} />
      <button type="button" data-testid="pick-image" onClick={() => onSelect("img-layer-1")} />
      <input data-testid="dock-field" type="text" defaultValue={60} />
      <button
        type="button"
        data-testid="widen-first"
        onClick={() => {
          const first = config.furniture[0];
          if (first) actions.onUpdateFurniture(first.id, { width: 3 });
        }}
      />
      <button
        type="button"
        data-testid="grow-room"
        onClick={() => room.onDimensionsChange({ ...room.dimensions, widthMeters: 7, depthMeters: 6 })}
      />
    </section>
  ),
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

vi.mock("../TemplateSelector", () => ({
  TemplateSelector: () => null,
}));

// The 3D room as what it hands the editor: the pick, and a WebGL failure.
const room3d = vi.hoisted(() => ({
  pick: null as ((objectId: string | null) => void) | null,
  fail: null as ((error: unknown) => void) | null,
  camera: undefined as { kind: string } | undefined,
  config: null as Record<string, unknown> | null,
  zones: null as { active: string | null; others: readonly string[] } | null | undefined,
  hover: null as ((objectId: string | null, x: number, y: number) => void) | null,
}));

vi.mock("@/features/room-view/ui/RoomView3DHost", () => ({
  // False here so the inspector's model choice stays as the other tests expect; a test passes
  // `view3dAvailable` itself.
  ROOM_VIEW_3D_AVAILABLE: false,
  RoomView3DHost: ({
    config,
    onPick,
    onFail,
    cameraCommand,
    zones,
    onHover,
  }: {
    onHover?: (objectId: string | null, x: number, y: number) => void;
    zones?: { active: string | null; others: readonly string[] } | null;
    config: Record<string, unknown>;
    onPick?: (objectId: string | null) => void;
    onFail: (error: unknown) => void;
    cameraCommand?: { kind: string };
  }) => {
    room3d.config = config;
    room3d.pick = onPick ?? null;
    room3d.camera = cameraCommand;
    room3d.fail = onFail;
    room3d.zones = zones;
    room3d.hover = onHover ?? null;
    return <div data-testid="room-view-3d" />;
  },
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

    const canvasContainer = container.querySelector('[data-testid="room-map-stage"]');
    expect(canvasContainer).not.toBeNull();
    expect(StubResizeObserver.observed).toContain(canvasContainer);
  });
});

// Placeholder stubs resolved where the decisions are actually made: ROOM-01 by
// `computeFit` (useRoomMapViewport.test.ts). ROOM-06 went with "LED counts from
// the map", ROOM-08 with `backgroundImagePath` in v1.5.x.

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
    const root = container.querySelector(".lm-room-editor") as HTMLElement;
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

  // WebKit rang the whole room with :focus-visible each time an action handed focus back to it.
  it("is ringed when Tab brings focus to it, not when an action hands focus back", async () => {
    const { root } = renderEditor();
    await act(async () => {});
    act(() => root.focus());
    expect(root).not.toHaveAttribute("data-tabbed");
    fireEvent.keyUp(root, { key: "Tab" });
    expect(root).toHaveAttribute("data-tabbed");
    act(() => root.blur());
    expect(root).not.toHaveAttribute("data-tabbed");
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
    persistState.apply.mockClear();
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
      root: container.querySelector(".lm-room-editor") as HTMLElement,
      field: getByTestId("dock-field"),
      getByTestId,
    };
  }

  it("does not delete the selected object on Backspace inside a field", () => {
    const { field } = renderWithTvSelected();

    act(() => {
      fireEvent.keyDown(field, { key: "Backspace" });
    });

    expect(persistState.apply).not.toHaveBeenCalledWith({ tvAnchor: undefined });
  });

  it("still deletes the selected object on Backspace outside a field", () => {
    const { root } = renderWithTvSelected();

    act(() => {
      fireEvent.keyDown(root, { key: "Backspace" });
    });

    expect(persistState.apply).toHaveBeenCalledWith({ tvAnchor: undefined });
  });

  it("leaves Cmd+Z inside a field to the field's own undo", () => {
    const { field } = renderWithTvSelected();

    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(field, { key: "z", code: "KeyZ", metaKey: true });
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
// Bare keys belong to the canvas, not to a control that has focus
// ---------------------------------------------------------------------------

describe("RoomMapEditor — bare keys stay on the canvas", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
    persistState.apply.mockClear();
    persistState.undo.mockClear();
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });

  async function renderEditor() {
    const view = render(<RoomMapEditor />);
    await act(async () => {});
    return view;
  }

  it("does not pan the map for an arrow on a dock control", async () => {
    const { getByTestId } = await renderEditor();
    const before = getByTestId("room-map-canvas").dataset.panX;

    act(() => {
      fireEvent.keyDown(getByTestId("dock-tab"), { key: "ArrowRight" });
    });

    expect(getByTestId("room-map-canvas").dataset.panX).toBe(before);
  });

  it("does not delete the selected object for Delete on a dock control", async () => {
    const { getByTestId } = await renderEditor();
    act(() => {
      getByTestId("select-tv").click();
    });

    act(() => {
      fireEvent.keyDown(getByTestId("dock-tab"), { key: "Delete" });
    });

    expect(persistState.apply).not.toHaveBeenCalledWith({ tvAnchor: undefined });
  });

  it("still deletes for Delete on an object inside the canvas", async () => {
    const { getByTestId } = await renderEditor();
    act(() => {
      getByTestId("select-tv").click();
    });

    act(() => {
      fireEvent.keyDown(getByTestId("select-tv"), { key: "Delete" });
    });

    expect(persistState.apply).toHaveBeenCalledWith({ tvAnchor: undefined });
  });

  it("keeps Cmd+Z editor-wide, the dock included", async () => {
    const { getByTestId } = await renderEditor();

    act(() => {
      fireEvent.keyDown(getByTestId("dock-tab"), { key: "z", code: "KeyZ", metaKey: true });
    });

    expect(persistState.undo).toHaveBeenCalledTimes(1);
  });

  it("leaves a space on a button to press the button instead of entering pan mode", async () => {
    const { getByTestId } = await renderEditor();

    let notPrevented = false;
    act(() => {
      notPrevented = fireEvent.keyDown(getByTestId("dock-tab"), { key: " " });
    });

    expect(getByTestId("room-map-canvas").dataset.panMode).toBe("false");
    expect(notPrevented).toBe(true);
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
    persistState.apply.mockClear();
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
      getByTestId("grow-room").click();
    });

    // 5 x 4 -> 7 x 6 shifts metre objects by half the growth, (1, 1).
    const calls = persistState.apply.mock.calls;
    const patch = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(patch.dimensions).toMatchObject({ widthMeters: 7, depthMeters: 6 });
    expect(patch.furniture).toEqual([expect.objectContaining({ x: 2, y: 3 })]);
    // Channels are fractions of the room and follow it with no write; adding
    // the metre shift once pushed x from 0.5 to 1.5, outside [-1, 1].
    expect(patch).not.toHaveProperty("hueChannels");
  });
});

describe("RoomMapEditor — an edit keeps what a newer build stored", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
    persistState.apply.mockClear();
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
    persistState.configOverride = {};
  });

  it("saves a piece of an unknown kind whole, with only the edited field changed", async () => {
    const stored = { id: "f", type: "hammock", x: 1, y: 1, width: 1, height: 1, variant: "swing", tone: "teal", topMeters: 2.2 };
    persistState.configOverride = { furniture: [stored] };
    const { getByTestId } = render(<RoomMapEditor />);
    await act(async () => {});

    act(() => getByTestId("widen-first").click());

    expect(persistState.apply).toHaveBeenLastCalledWith(
      { furniture: [{ ...stored, width: 3 }] },
      { gesture: "furniture:f:width" },
    );
  });
});

describe("RoomMapEditor — letting go of a selection", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });

  function renderWithZoneAndTv() {
    const view = render(<RoomMapEditor />);
    act(() => view.getByTestId("pick-zone").click());
    act(() => view.getByTestId("select-tv").click());
    const dock = view.getByTestId("room-dock");
    expect(dock.dataset.selected).toBe("tv");
    expect(dock.dataset.zone).toBe("zone-1");
    return { ...view, dock, root: view.container.querySelector(".lm-room-editor") as HTMLElement };
  }

  it("steps back one at a time on Escape: the object, then the zone it was picked over", () => {
    const { root, dock } = renderWithZoneAndTv();
    act(() => {
      fireEvent.keyDown(root, { key: "Escape" });
    });
    expect(dock.dataset.selected).toBe("");
    expect(dock.dataset.zone).toBe("zone-1");
    act(() => {
      fireEvent.keyDown(root, { key: "Escape" });
    });
    expect(dock.dataset.zone).toBe("");
  });

  // `select(null)` alone left the zone selected, so the palette never came back.
  it("lets go of both on a click on empty ground", () => {
    const { getByTestId, dock } = renderWithZoneAndTv();
    act(() => getByTestId("empty-ground").click());
    expect(dock.dataset.selected).toBe("");
    expect(dock.dataset.zone).toBe("");
  });

  it("opens no plan menu for a right-click in the dock", () => {
    const { getByTestId } = renderWithZoneAndTv();
    // Not prevented: the plan's menu is the canvas's, and a popover's right-click bubbles here too.
    expect(fireEvent.contextMenu(getByTestId("dock-tab"))).toBe(true);
    expect(fireEvent.contextMenu(getByTestId("select-tv"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Editing in 3D
// ---------------------------------------------------------------------------

describe("RoomMapEditor — the 3D room as the editing stage", () => {
  const openEdit = async () => {
    const view = render(<RoomMapSurface view3dAvailable />);
    await act(async () => {});
    // The editor reads its grid settings as it mounts; flushed here, they land inside act.
    await act(async () => (view.getByRole("radio", { name: "roomMap:face.edit" }) as HTMLElement).click());
    return view;
  };
  const stageRadio = (view: ReturnType<typeof render>, name: string) => view.getByRole("radio", { name }) as HTMLElement;

  afterEach(() => {
    __resetEditStage();
    __resetRoomViewFailure();
    room3d.pick = null;
    room3d.fail = null;
    room3d.camera = undefined;
  });

  // The maintainer wants the room laid out in 3D: Edit opened on the plan alone.
  it("opens Edit on the 3D room with the dock, and the plan a switch away that the next Edit remembers", async () => {
    const view = await openEdit();
    expect(view.getByTestId("room-view-3d")).toBeInTheDocument();
    expect(view.queryByTestId("room-map-canvas")).toBeNull();
    expect(view.getByTestId("room-dock")).toBeInTheDocument();
    expect(stageRadio(view, "roomMap:stage.room")).toHaveAttribute("aria-checked", "true");
    // The stage it opens on is there at once; only a switch fades the next one in.
    const stage = view.getByTestId("room-map-stage");
    expect(stage).toHaveAttribute("data-stage", "room");
    expect(stage).not.toHaveAttribute("data-switched");

    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    expect(view.getByTestId("room-map-canvas")).toBeInTheDocument();
    expect(view.queryByTestId("room-view-3d")).toBeNull();
    expect(stage).toHaveAttribute("data-stage", "plan");
    expect(stage).toHaveAttribute("data-switched");

    view.unmount();
    const again = await openEdit();
    expect(again.getByTestId("room-map-canvas")).toBeInTheDocument();
  });

  it("selects what is picked in the room for the dock's card, and lets go on empty floor", async () => {
    const view = await openEdit();
    act(() => room3d.pick?.("tv"));
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-selected", "tv");
    act(() => room3d.pick?.(null));
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-selected", "");
  });

  it("keeps a zone picked from the list in the 3D room, outlined there, and through a stage switch", async () => {
    const view = await openEdit();
    await act(async () => view.getByTestId("pick-zone").click());
    expect(view.getByTestId("room-view-3d")).toBeInTheDocument();
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-zone", "zone-1");
    expect(room3d.zones?.active).toBe("zone-1");
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    await act(async () => stageRadio(view, "roomMap:stage.room").click());
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-zone", "zone-1");
  });

  it("names what is under the pointer in the 3D room, and lets go off it", async () => {
    const view = await openEdit();
    act(() => room3d.hover?.("tv", 200, 200));
    expect(view.getByText("roomMap:objectPanel.tvLabel")).toBeInTheDocument();
    act(() => room3d.hover?.(null, 0, 0));
    expect(view.queryByText("roomMap:objectPanel.tvLabel")).toBeNull();
  });

  it("adds a zone in the 3D room, where it is drawn now", async () => {
    const view = await openEdit();
    await act(async () => view.getByTestId("add-zone").click());
    expect(view.getByTestId("room-view-3d")).toBeInTheDocument();
  });

  it("arms a draw on the plan instead of adding a zone, and Escape or the 3D room disarms it", async () => {
    const view = await openEdit();
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    persistState.apply.mockClear();
    await act(async () => view.getByTestId("add-zone").click());
    expect(view.getByTestId("zone-draw-layer")).toBeInTheDocument();
    expect(view.getByTestId("carry-hint")).toHaveAttribute("data-hint", "draw");
    expect(persistState.apply).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(view.queryByTestId("zone-draw-layer")).toBeNull();
    await act(async () => view.getByTestId("add-zone").click());
    await act(async () => stageRadio(view, "roomMap:stage.room").click());
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    expect(view.queryByTestId("zone-draw-layer")).toBeNull();
  });

  it("adds a zone at once from the keyboard, which cannot drag one, and ends a draw on a pick", async () => {
    const view = await openEdit();
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    await act(async () => view.getByTestId("add-zone-key").click());
    expect(view.queryByTestId("zone-draw-layer")).toBeNull();
    await act(async () => view.getByTestId("add-zone").click());
    expect(view.getByTestId("zone-draw-layer")).toBeInTheDocument();
    await act(async () => view.getByTestId("pick-zone").click());
    expect(view.queryByTestId("zone-draw-layer")).toBeNull();
  });

  it("ends a draw when a template is shown, so the drawn zone never lands on it", async () => {
    const view = await openEdit();
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    await act(async () => view.getByTestId("add-zone").click());
    expect(view.getByTestId("zone-draw-layer")).toBeInTheDocument();
    await act(async () => view.getByTestId("preview-template").click());
    expect(view.queryByTestId("zone-draw-layer")).toBeNull();
  });

  it("opens the plan for an image picked from the list, and closes its card going back to 3D", async () => {
    const view = await openEdit();
    await act(async () => view.getByTestId("pick-image").click());
    expect(view.getByTestId("room-map-canvas")).toBeInTheDocument();
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-selected", "img-layer-1");
    await act(async () => stageRadio(view, "roomMap:stage.room").click());
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-selected", "");
  });

  // ⌘0 fitted the hidden plan: in 3D it is the camera's "Whole room".
  it("sends ⌘0 to the camera in the 3D room", async () => {
    const view = await openEdit();
    const root = view.container.querySelector(".lm-room-editor") as HTMLElement;
    await act(async () => fireEvent.keyDown(root, { key: "0", code: "Digit0", metaKey: true }));
    expect(room3d.camera).toMatchObject({ kind: "reset" });
  });

  it("falls back to the plan with no stage switch when the 3D room cannot open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await openEdit();
    await act(async () => room3d.fail?.(new Error("no WebGL")));
    expect(view.getByTestId("room-map-canvas")).toBeInTheDocument();
    expect(view.queryByRole("radio", { name: "roomMap:stage.plan" })).toBeNull();
  });

  // A drawer closed with nothing previewed left the plan following templates: the next resize refitted it.
  it("leaves a later room resize unfitted after a drawer closed without a preview", async () => {
    const view = await openEdit();
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    await act(async () => view.getByTestId("leave-template").click());
    const canvas = view.getByTestId("room-map-canvas");
    const pan = [canvas.dataset.panX, canvas.dataset.panY];
    persistState.configOverride = { dimensions: { widthMeters: 9, depthMeters: 7 } };
    view.rerender(<RoomMapSurface view3dAvailable />);
    await act(async () => {});
    expect([canvas.dataset.panX, canvas.dataset.panY]).toEqual(pan);
    persistState.configOverride = {};
  });

  it("keeps a group selection through a preview", async () => {
    persistState.configOverride = {
      furniture: [
        { id: "m1", type: "chair", x: 1, y: 1, width: 0.5, height: 0.5 },
        { id: "m2", type: "chair", x: 2, y: 1, width: 0.5, height: 0.5 },
      ],
    };
    const view = await openEdit();
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    const piece = (id: string) => view.container.querySelector(`[data-piece="${id}"]`) as HTMLElement;
    await act(async () => piece("m1").click());
    await act(async () => piece("m2").click());
    expect(piece("m2")).toHaveAttribute("data-grouped");
    await act(async () => view.getByTestId("preview-template").click());
    await act(async () => view.getByTestId("leave-template").click());
    expect(piece("m1")).toHaveAttribute("data-grouped");
    expect(piece("m2")).toHaveAttribute("data-grouped");
    persistState.configOverride = {};
  });

  it("resizes the saved room, not the template on show", async () => {
    persistState.apply.mockClear();
    persistState.configOverride = { furniture: [{ id: "mine", type: "chair", x: 1, y: 1, width: 0.5, height: 0.5 }] };
    const view = await openEdit();
    await act(async () => view.getByTestId("preview-template").click());
    await act(async () => view.getByTestId("grow-room").click());
    const patch = persistState.apply.mock.calls[0]![0] as { dimensions: { widthMeters: number }; furniture: Array<{ id: string; x: number }> };
    expect(patch.furniture.map((f) => f.id)).toEqual(["mine"]);
    // The saved room is 5 m wide: a metre more each side of its middle.
    expect(patch.furniture[0]!.x).toBeCloseTo(2);
    persistState.configOverride = {};
  });

  it("edits a saved piece from the inspector without writing the template on show", async () => {
    persistState.apply.mockClear();
    persistState.configOverride = { furniture: [{ id: "mine", type: "chair", x: 1, y: 1, width: 0.5, height: 0.5 }] };
    const view = await openEdit();
    await act(async () => view.getByTestId("preview-template").click());
    await act(async () => view.getByTestId("widen-first").click());
    const patch = persistState.apply.mock.calls[0]![0] as { furniture: Array<{ id: string; width: number }> };
    expect(patch.furniture.map((f) => [f.id, f.width])).toEqual([["mine", 3]]);
    persistState.configOverride = {};
  });

  // The drawer's cards sit in a portal, and their keys still bubble to the editor through React.
  it("leaves Cmd+Z unanswered while a template is previewed", async () => {
    persistState.undo.mockClear();
    const view = await openEdit();
    const root = view.container.querySelector(".lm-room-editor") as HTMLElement;
    await act(async () => view.getByTestId("preview-template").click());
    await act(async () => fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true }));
    expect(persistState.undo).not.toHaveBeenCalled();
    await act(async () => view.getByTestId("leave-template").click());
    await act(async () => fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true }));
    expect(persistState.undo).toHaveBeenCalledOnce();
  });

  // Laid out again from the template, the room came back as new objects and the 3D morph restarted.
  it("applies the very room it previewed", async () => {
    persistState.replace.mockClear();
    persistState.configOverride = {
      usbStrips: [{ stripId: "strip-1", portName: "/dev/cu.usb", ledCount: 60, startX: 0, startY: 0, endX: 1, endY: 0 }],
    };
    const view = await openEdit();
    await act(async () => view.getByTestId("preview-template").click());
    const shown = room3d.config!;
    await act(async () => view.getByTestId("apply-template").click());
    const applied = persistState.replace.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(applied).filter((key) => applied[key] !== shown[key])).toEqual([]);
    persistState.configOverride = {};
  });

  it("shows a template the drawer rests on without saving it, and lays it out as one step when applied", async () => {
    persistState.apply.mockClear();
    persistState.replace.mockClear();
    persistState.configOverride = { furniture: [{ id: "mine", type: "chair", x: 1, y: 1, width: 0.5, height: 0.5 }] };
    const view = await openEdit();
    const stage = view.getByTestId("room-map-stage");
    await act(async () => stageRadio(view, "roomMap:stage.plan").click());
    await act(async () => view.getByTestId("preview-template").click());
    expect(view.getAllByTestId("plan-piece")).toHaveLength(2);
    expect(view.getByTestId("room-dock")).toHaveAttribute("data-furniture", "1");
    expect(stage).toHaveAttribute("data-previewing");
    await act(async () => view.getByTestId("leave-template").click());
    expect(view.getAllByTestId("plan-piece")).toHaveLength(1);
    expect(stage).not.toHaveAttribute("data-previewing");
    expect(persistState.apply).not.toHaveBeenCalled();
    expect(persistState.replace).not.toHaveBeenCalled();

    await act(async () => view.getByTestId("preview-template").click());
    await act(async () => view.getByTestId("apply-template").click());
    expect(persistState.replace).toHaveBeenCalledOnce();
    expect(persistState.replace).toHaveBeenCalledWith(expect.objectContaining({ furniture: TEMPLATE.furniture }));
    expect(persistState.apply).not.toHaveBeenCalled();
    persistState.configOverride = {};
  });
});
