// Room height drives Hue's vertical sampling, every metre readout on a Hue
// channel, and the TV's "above the ceiling" check — and had no field at all.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPreferencesForTests, __setPreferenceForTests } from "@/features/persistence/preferences";
import { DEFAULT_ROOM_DIMENSIONS, type RoomDimensions } from "@/shared/contracts/roomMap";

import { RoomPanel, ROOM_HEIGHT_MAX_M, ROOM_HEIGHT_MIN_M, type RoomSettings } from "../RoomPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { percent?: number; band?: string }) => (values?.band ? `${key}:${values.percent}:${values.band}` : key),
  }),
}));

const saves = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: (partial: Record<string, unknown>) => {
      saves.push(partial);
      return Promise.resolve();
    },
    onSaved: () => () => {},
  },
}));

// Seeded, so the Ambient row never starts a load that lands outside act().
beforeEach(() => {
  __setPreferenceForTests("roomMapAmbient", 35);
});

afterEach(() => {
  saves.length = 0;
  // Unmounted first: a reset under a mounted row is an update outside act().
  cleanup();
  __resetPreferencesForTests();
});

function settings(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return {
    dimensions: DEFAULT_ROOM_DIMENSIONS,
    onDimensionsChange: vi.fn<(d: RoomDimensions) => void>(),
    shape: { kind: "rect" },
    onShapeChange: vi.fn<RoomSettings["onShapeChange"]>(),
    minimumSize: { widthMeters: 0, depthMeters: 0 },
    showGrid: false,
    onShowGridChange: vi.fn<(show: boolean) => void>(),
    gridStrokeWidth: 1,
    onGridStrokeWidthChange: vi.fn<(width: number) => void>(),
    showHueZones: true,
    onShowHueZonesChange: vi.fn<(show: boolean) => void>(),
    ...overrides,
  };
}

function Harness({ values, onReset, onTemplates }: { values: RoomSettings; onReset: () => void; onTemplates?: () => void }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        anchor
      </button>
      <RoomPanel open onClose={vi.fn<() => void>()} anchorRef={anchorRef} id="room" settings={values} onReset={onReset} onTemplates={onTemplates} />
    </>
  );
}

function renderPanel(values = settings(), onReset = vi.fn<() => void>()) {
  render(<Harness values={values} onReset={onReset} />);
  return { values, onReset };
}

function commit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("RoomPanel — room height", () => {
  it("edits the height and leaves width and depth alone", () => {
    const { values } = renderPanel();
    commit(screen.getByLabelText("roomMap:settings.roomHeight"), "3.2");
    expect(values.onDimensionsChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROOM_DIMENSIONS, heightMeters: 3.2 });
  });

  it("holds the height inside sensible bounds, putting the old value back outside them", () => {
    const { values } = renderPanel();
    const input = screen.getByLabelText("roomMap:settings.roomHeight") as HTMLInputElement;
    commit(input, "0.2");
    commit(input, "40");
    expect(values.onDimensionsChange).not.toHaveBeenCalled();
    expect(input.value).toBe(DEFAULT_ROOM_DIMENSIONS.heightMeters.toFixed(2));
    commit(input, String(ROOM_HEIGHT_MAX_M));
    expect(values.onDimensionsChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROOM_DIMENSIONS, heightMeters: ROOM_HEIGHT_MAX_M });
    commit(input, String(ROOM_HEIGHT_MIN_M));
    expect(values.onDimensionsChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROOM_DIMENSIONS, heightMeters: ROOM_HEIGHT_MIN_M });
  });

  it("says what the height is for", () => {
    renderPanel();
    expect(screen.getByLabelText("roomMap:settings.roomHeight")).toHaveAccessibleDescription("roomMap:settings.roomHeightHint");
  });
});

describe("RoomPanel — what the plan draws", () => {
  it("offers the grid thickness only while the grid is shown", () => {
    renderPanel(settings({ showGrid: false }));
    expect(screen.getByRole("slider", { name: "roomMap:settings.gridStrokeWidth" })).toBeDisabled();
  });

  it("switches the grid and the zone bounds as switches", () => {
    const { values } = renderPanel(settings({ showGrid: false, showHueZones: true }));
    fireEvent.click(screen.getByRole("switch", { name: "roomMap:settings.showGrid" }));
    fireEvent.click(screen.getByRole("switch", { name: "roomMap:settings.showHueZones" }));
    expect(values.onShowGridChange).toHaveBeenCalledWith(true);
    expect(values.onShowHueZonesChange).toHaveBeenCalledWith(false);
  });

  it("opens the templates from the panel where the editor offers them", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "roomMap:settings.templates" })).toBeNull();
    cleanup();
    const onTemplates = vi.fn<() => void>();
    render(<Harness values={settings()} onReset={vi.fn<() => void>()} onTemplates={onTemplates} />);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:settings.templates" }));
    expect(onTemplates).toHaveBeenCalledTimes(1);
  });

  it("asks before a reset rather than resetting from the panel", () => {
    const { onReset } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "roomMap:settings.resetMap" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("RoomPanel — the room's floor and walls", () => {
  it("offers them only where the 3D room draws them", () => {
    renderPanel();
    expect(screen.queryByRole("radiogroup", { name: "roomMap:settings.floor" })).toBeNull();
  });

  it("marks what is stored and hands over only the surface picked", () => {
    const onChange = vi.fn<(patch: { floor?: string; walls?: string }) => void>();
    renderPanel(settings({ surfaces: { value: { floor: "walnut" }, onChange } }));
    const floor = screen.getByRole("radiogroup", { name: "roomMap:settings.floor" });
    expect(floor.querySelector('[aria-checked="true"]')?.getAttribute("aria-label")).toBe("roomMap:surfaces.floor.walnut");
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:surfaces.walls.clay" }));
    expect(onChange).toHaveBeenLastCalledWith({ walls: "clay" });
  });
});

describe("RoomPanel — on the 3D stage", () => {
  it("hides the plan's grid and zone switches, which the 3D room does not draw", () => {
    renderPanel(settings({ onPlan: false }));
    expect(screen.queryByLabelText("roomMap:settings.showGrid")).toBeNull();
    expect(screen.queryByLabelText("roomMap:settings.showHueZones")).toBeNull();
    expect(screen.getByLabelText("roomMap:settings.roomHeight")).toBeInTheDocument();
    cleanup();
    renderPanel();
    expect(screen.getByLabelText("roomMap:settings.showGrid")).toBeInTheDocument();
  });
});
