// Room height drives Hue's vertical sampling, every metre readout on a Hue
// channel, and the TV's "above the ceiling" check — and had no field at all.
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_DIMENSIONS, type RoomDimensions } from "@/shared/contracts/roomMap";

import { RoomPanel, ROOM_HEIGHT_MAX_M, ROOM_HEIGHT_MIN_M, type RoomSettings } from "../RoomPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

function Harness({ values, onReset }: { values: RoomSettings; onReset: () => void }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        anchor
      </button>
      <RoomPanel open onClose={vi.fn<() => void>()} anchorRef={anchorRef} id="room" settings={values} onReset={onReset} />
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

  it("asks before a reset rather than resetting from the panel", () => {
    const { onReset } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "roomMap:settings.resetMap" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
