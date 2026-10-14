import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig, type UsbStripPlacement } from "@/shared/contracts/roomMap";

import type { InspectorActions } from "../DockInspector";
import { DOCK_HEIGHT_PX } from "../dockGeometry";
import { RoomDock, type RoomDockProps } from "../RoomDock";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const strip = (stripId: string, ledCount: number): UsbStripPlacement => ({ stripId, startX: 1, startY: 0.2, endX: 3, endY: 0.2, ledCount });

const config: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  furniture: [{ id: "sofa", type: "sofa", x: 1, y: 2, width: 2, height: 0.9, label: "Sofa" }],
  usbStrips: [strip("a", 60), strip("b", 144)],
};

function actions(): InspectorActions {
  return {
    onUpdateTvAnchor: vi.fn<InspectorActions["onUpdateTvAnchor"]>(),
    onUpdateFurniture: vi.fn<InspectorActions["onUpdateFurniture"]>(),
    onUpdateUsbStrip: vi.fn<InspectorActions["onUpdateUsbStrip"]>(),
    onUpdateImageLayer: vi.fn<InspectorActions["onUpdateImageLayer"]>(),
    onMoveObject: vi.fn<InspectorActions["onMoveObject"]>(),
    onHueChannelHeightChange: vi.fn<InspectorActions["onHueChannelHeightChange"]>(),
    onRename: vi.fn<InspectorActions["onRename"]>(),
    onToggleLock: vi.fn<InspectorActions["onToggleLock"]>(),
    onDuplicate: vi.fn<InspectorActions["onDuplicate"]>(),
    onDelete: vi.fn<InspectorActions["onDelete"]>(),
    onUpdateHueZone: vi.fn<InspectorActions["onUpdateHueZone"]>(),
    onRenameHueZone: vi.fn<InspectorActions["onRenameHueZone"]>(),
    onDeleteHueZone: vi.fn<InspectorActions["onDeleteHueZone"]>(),
    onAssignChannelToZone: vi.fn<InspectorActions["onAssignChannelToZone"]>(),
  };
}

const spies = {
  onFocusEditor: vi.fn<() => void>(),
  onReset: vi.fn<() => void>(),
  onAddFurniture: vi.fn<(type: string) => void>(),
};

/** The dock over a selection it shares with "the canvas": `select` stands for a click there. */
function Harness({
  initial = null,
  initialZone = null,
  onSelectRef,
}: {
  initial?: string | null;
  initialZone?: string | null;
  onSelectRef?: { current: (id: string | null) => void };
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initial);
  if (onSelectRef) onSelectRef.current = setSelectedId;
  const inspectorActions: InspectorActions = {
    ...actions(),
    // As the editor does: a copy comes selected, a deleted object leaves nothing selected.
    onDuplicate: () => setSelectedId("usb-b"),
    onDelete: () => setSelectedId(null),
  };
  const props: RoomDockProps = {
    config,
    zones: [],
    selectedId,
    activeHueZoneId: initialZone,
    channels: [],
    areaChannels: [],
    liveChannelIds: null,
    stripStatus: () => ({ status: "unknown", port: null }),
    hueBridgeStatus: "unknown",
    modelChoices: false,
    actions: inspectorActions,
    add: {
      hasTv: false,
      onAddFurniture: (type) => {
        spies.onAddFurniture(type);
        setSelectedId("furniture-sofa");
      },
      onAddTv: vi.fn<() => void>(),
      onSelectTv: vi.fn<() => void>(),
      onAddStrip: vi.fn<() => void>(),
      onAddImage: vi.fn<() => void>(),
      onAddZone: vi.fn<() => void>(),
    },
    hue: null,
    room: {
      dimensions: DEFAULT_ROOM_MAP.dimensions,
      onDimensionsChange: vi.fn<RoomDockProps["room"]["onDimensionsChange"]>(),
      showGrid: true,
      onShowGridChange: vi.fn<(show: boolean) => void>(),
      gridStrokeWidth: 1,
      onGridStrokeWidthChange: vi.fn<(width: number) => void>(),
      showHueZones: true,
      onShowHueZonesChange: vi.fn<(show: boolean) => void>(),
    },
    onReset: spies.onReset,
    onSelect: setSelectedId,
    onSelectZone: vi.fn<(zoneId: string) => void>(),
    onPopSelection: () => setSelectedId(null),
    onFocusEditor: spies.onFocusEditor,
  };
  return <RoomDock {...props} />;
}

const dock = () => screen.getByRole("region", { name: "roomMap:dock.label" });

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset();
});

describe("RoomDock", () => {
  it("keeps one height whatever it shows", () => {
    render(<Harness />);
    expect(dock().style.getPropertyValue("--room-dock-h")).toBe(`${DOCK_HEIGHT_PX}px`);
  });

  it("shows what can be added with nothing selected, and the selection's inspector once there is one", () => {
    const select = { current: (_id: string | null) => {} };
    render(<Harness onSelectRef={select} />);
    expect(screen.getByRole("toolbar", { name: "roomMap:palette.label" })).toBeInTheDocument();
    act(() => select.current("usb-a"));
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.usbLedCountLabel" })).toHaveValue("60");
  });

  // Without the `kind:id` remount, the LED field's typed text carried from one strip to the next.
  it("starts a new strip's inspector afresh rather than carrying the last one's typing", () => {
    const select = { current: (_id: string | null) => {} };
    render(<Harness initial="usb-a" onSelectRef={select} />);
    const field = screen.getByRole("spinbutton", { name: "roomMap:inspector.usbLedCountLabel" });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "99" } });
    act(() => select.current("usb-b"));
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.usbLedCountLabel" })).toHaveValue("144");
  });

  it("announces a selection made on the canvas, and leaves focus alone", () => {
    const select = { current: (_id: string | null) => {} };
    render(<Harness onSelectRef={select} />);
    act(() => select.current("furniture-sofa"));
    expect(screen.getByRole("status")).toHaveTextContent('roomMap:dock.selected {"type":"roomMap:inspector.typeFurniture","name":"Sofa"}');
    expect(spies.onFocusEditor).not.toHaveBeenCalled();
  });

  it("lands a keyboard pick from the dock on the inspector's first field, without announcing it", () => {
    render(<Harness />);
    // A click with no pointer behind it is Enter or Space on the tile.
    fireEvent.click(screen.getByTestId("palette-sofa"), { detail: 0 });
    expect(spies.onAddFurniture).toHaveBeenCalledWith("sofa");
    expect(screen.getByRole("textbox", { name: "roomMap:inspector.furnitureNameLabel" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("hands the keys back to the editor after a pointer pick", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("palette-sofa"), { detail: 1 });
    expect(spies.onFocusEditor).toHaveBeenCalledTimes(1);
  });

  it("picks from the objects list and closes it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.objects" }));
    const list = within(screen.getByRole("dialog", { name: "roomMap:dock.objects" }));
    fireEvent.click(list.getByRole("button", { name: "roomMap:objectPanel.ledLabel {\"count\":\"144\"}" }), { detail: 0 });
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.xLabel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "roomMap:dock.objects" })).toHaveAttribute("aria-expanded", "false");
  });

  it("goes back to the palette on ✕ and hands the keys back to the editor", () => {
    render(<Harness initial="usb-a" />);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.close" }));
    expect(screen.getByRole("toolbar", { name: "roomMap:palette.label" })).toBeInTheDocument();
    expect(spies.onFocusEditor).toHaveBeenCalled();
  });

  it("sends Escape in the dock back to the editor without letting go of the selection", () => {
    render(<Harness initial="usb-a" />);
    const close = screen.getByRole("button", { name: "roomMap:dock.close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(spies.onFocusEditor).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.usbLedCountLabel" })).toBeInTheDocument();
  });

  it("asks before resetting the map, the question taking the room panel's place", () => {
    render(<Harness />);
    const room = screen.getByRole("button", { name: "roomMap:dock.room" });
    fireEvent.click(room);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:settings.resetMap" }));
    expect(room).toHaveAttribute("aria-expanded", "false");
    expect(spies.onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("room-reset-confirm-yes"));
    expect(spies.onReset).toHaveBeenCalledTimes(1);
  });

  // The focused button goes with the inspector it was in; the keys must not be left with nowhere.
  it("hands the keys back to the editor after a delete from the inspector", () => {
    render(<Harness initial="usb-a" />);
    const del = screen.getByRole("button", { name: "roomMap:objectPanel.delete" });
    act(() => del.focus());
    fireEvent.click(del, { detail: 0 });
    expect(spies.onFocusEditor).toHaveBeenCalledTimes(1);
  });

  it("hands the keys back after a duplicate too", () => {
    render(<Harness initial="usb-a" />);
    const dup = screen.getByRole("button", { name: "roomMap:contextMenu.duplicate" });
    act(() => dup.focus());
    fireEvent.click(dup, { detail: 0 });
    expect(spies.onFocusEditor).toHaveBeenCalledTimes(1);
  });

  it("lands focus at once on a pick of what is already selected", () => {
    render(<Harness initial="usb-a" />);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.objects" }));
    const list = within(screen.getByRole("dialog", { name: "roomMap:dock.objects" }));
    fireEvent.click(list.getByRole("button", { name: 'roomMap:objectPanel.ledLabel {"count":"60"}' }), { detail: 0 });
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.xLabel" })).toHaveFocus();
  });

  it("shows no inspector for a zone of another area, whose lights are not these", () => {
    render(<Harness initialZone="zone-elsewhere" />);
    expect(screen.getByRole("toolbar", { name: "roomMap:palette.label" })).toBeInTheDocument();
  });
});
