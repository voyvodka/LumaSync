import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FurnitureType } from "@/shared/contracts/roomMap";

import { DockPalette, type DockPaletteProps } from "../DockPalette";
import type { PaletteHueArea } from "../HueAreaNote";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

function renderPalette(overrides: Partial<DockPaletteProps> = {}) {
  const props: DockPaletteProps = {
    hasTv: false,
    onAddFurniture: vi.fn<(type: FurnitureType) => void>(),
    onAddTv: vi.fn<() => void>(),
    onSelectTv: vi.fn<() => void>(),
    onAddStrip: vi.fn<() => void>(),
    onAddImage: vi.fn<() => void>(),
    onAddZone: vi.fn<() => void>(),
    hue: null,
    ...overrides,
  };
  render(<DockPalette {...props} />);
  return props;
}

const tile = (testId: string) => screen.getByTestId(testId);
const ready: PaletteHueArea = { state: { kind: "ready", orphanedAreaId: false }, zoneCount: 2, lightCount: 4, channelsStatus: null, refreshing: false };

describe("DockPalette", () => {
  it("adds a piece of the pressed type", () => {
    const props = renderPalette();
    fireEvent.click(tile("palette-table"));
    expect(props.onAddFurniture).toHaveBeenCalledWith("table", expect.anything());
  });

  it("names each piece's size in its tooltip", () => {
    renderPalette();
    expect(tile("palette-sofa").getAttribute("title")).toBe(
      'roomMap:palette.size {"name":"roomMap:furniture.type.sofa","width":"2.0","depth":"0.9"}',
    );
  });

  it("takes you to the TV there is instead of adding a second", () => {
    const props = renderPalette({ hasTv: true });
    expect(tile("palette-tv")).toHaveAccessibleName("roomMap:palette.selectTv");
    fireEvent.click(tile("palette-tv"));
    expect(props.onSelectTv).toHaveBeenCalledTimes(1);
    expect(props.onAddTv).not.toHaveBeenCalled();
  });

  it("offers a zone only to a room with a Hue side, and says how the area stands", () => {
    renderPalette();
    expect(screen.queryByTestId("palette-zone")).toBeNull();

    cleanup();
    const onRefresh = vi.fn<() => void>();
    const props = renderPalette({ hue: { ...ready, onRefresh } });
    fireEvent.click(tile("palette-zone"));
    expect(props.onAddZone).toHaveBeenCalledTimes(1);
    expect(screen.getByText('roomMap:hueZones.areaState.readyZones {"count":4,"zones":2}')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "roomMap:hueZones.areaState.refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("sends a zone pressed with no area to the way to get one", () => {
    const onNavigateToDevices = vi.fn<() => void>();
    const props = renderPalette({
      hue: { state: { kind: "no-area", orphanedAreaId: false }, zoneCount: 0, lightCount: 0, channelsStatus: null, refreshing: false, onNavigateToDevices },
    });
    const zone = tile("palette-zone");
    expect(zone).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(zone);
    expect(props.onAddZone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "roomMap:hueZones.areaState.noAreaCta" })).toHaveFocus();
  });

  it("is one tab stop: arrows walk the tiles and change row at the nearest column, and never add", () => {
    const props = renderPalette();
    const tiles = screen.getAllByRole("button");
    expect(tiles.filter((b) => b.tabIndex === 0)).toHaveLength(1);

    const sofa = tile("palette-sofa");
    sofa.focus();
    fireEvent.keyDown(sofa, { key: "ArrowRight" });
    expect(tile("palette-table")).toHaveFocus();
    fireEvent.keyDown(tile("palette-table"), { key: "ArrowDown" });
    expect(tile("palette-strip")).toHaveFocus();
    fireEvent.keyDown(tile("palette-strip"), { key: "ArrowUp" });
    expect(tile("palette-table")).toHaveFocus();
    fireEvent.keyDown(tile("palette-table"), { key: "End" });
    expect(tile("palette-image")).toHaveFocus();
    fireEvent.keyDown(tile("palette-image"), { key: "Home" });
    expect(sofa).toHaveFocus();
    // From the end of the first row, ↓ lands on the last tile of the shorter second row.
    fireEvent.keyDown(sofa, { key: "End" });
    fireEvent.keyDown(tile("palette-image"), { key: "ArrowUp" });
    expect(tile("palette-chair")).toHaveFocus();
    fireEvent.keyDown(tile("palette-chair"), { key: "End" });
    expect(props.onAddFurniture).not.toHaveBeenCalled();
    expect(tile("palette-image").tabIndex).toBe(0);
  });
});
