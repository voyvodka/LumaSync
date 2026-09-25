// Room height drives Hue's vertical sampling, every metre readout on a Hue
// channel, and the TV's "above the ceiling" check — and had no field at all.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_DIMENSIONS, type RoomDimensions } from "@/shared/contracts/roomMap";

import { RoomMapSettingsPopover, ROOM_HEIGHT_MAX_M, ROOM_HEIGHT_MIN_M } from "../RoomMapSettingsPopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderPopover(onDimensionsChange = vi.fn<(d: RoomDimensions) => void>(), dimensions: RoomDimensions = DEFAULT_ROOM_DIMENSIONS) {
  render(
    <RoomMapSettingsPopover
      open
      onClose={vi.fn<() => void>()}
      dimensions={dimensions}
      showGrid={false}
      gridStrokeWidth={1}
      showHueZones
      onDimensionsChange={onDimensionsChange}
      onGridToggle={vi.fn<(v: boolean) => void>()}
      onGridStrokeWidthChange={vi.fn<(v: number) => void>()}
      onHueZonesToggle={vi.fn<(v: boolean) => void>()}
      onReset={vi.fn<() => void>()}
    />,
  );
  return onDimensionsChange;
}

function commit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("RoomMapSettingsPopover — room height", () => {
  it("edits the height and leaves width and depth alone", () => {
    const onChange = renderPopover();
    commit(screen.getByLabelText("roomMap:settings.roomHeight"), "3.2");
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROOM_DIMENSIONS, heightMeters: 3.2 });
  });

  it("holds the height inside sensible bounds", () => {
    const onChange = renderPopover();
    const input = screen.getByLabelText("roomMap:settings.roomHeight");
    commit(input, "0.2");
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROOM_DIMENSIONS, heightMeters: ROOM_HEIGHT_MIN_M });
    commit(input, "40");
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ROOM_DIMENSIONS, heightMeters: ROOM_HEIGHT_MAX_M });
  });

  it("says what the height is for", () => {
    renderPopover();
    expect(screen.getByLabelText("roomMap:settings.roomHeight")).toHaveAccessibleDescription(
      "roomMap:settings.roomHeightHint",
    );
  });
});
