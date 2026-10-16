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
    onAddZone: vi.fn<() => void>(),
    hue: null,
    ...overrides,
  };
  render(<DockPalette {...props} />);
  return props;
}

const tile = (testId: string) => screen.getByTestId(testId);
const shelf = (tab: "furniture" | "light" | "screen") => {
  if (tile("palette-add").getAttribute("aria-expanded") !== "true") fireEvent.click(tile("palette-add"));
  fireEvent.click(tile(`library-tab-${tab}`));
};
const ready: PaletteHueArea = { state: { kind: "ready", orphanedAreaId: false }, zoneCount: 2, lightCount: 4, channelsStatus: null, refreshing: false };

describe("DockPalette", () => {
  it("is one row: Add, the templates where the editor has them, and the Hue area's state", () => {
    const onTemplates = vi.fn<() => void>();
    renderPalette({ onTemplates, hue: ready });
    expect(screen.queryByTestId("library-cards")).toBeNull();
    fireEvent.click(tile("palette-templates"));
    expect(onTemplates).toHaveBeenCalledOnce();
    expect(screen.getByText('roomMap:hueZones.areaState.readyZones {"count":4,"zones":2}')).toBeInTheDocument();
    cleanup();
    renderPalette();
    expect(screen.queryByTestId("palette-templates")).toBeNull();
  });

  it("opens the library from Add, its own press closing it", () => {
    renderPalette();
    const add = tile("palette-add");
    expect(add).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "roomMap:library.label" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { checked: true })).toHaveFocus();
    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "false");
  });

  it("adds a piece of the pressed type and closes the library", () => {
    const props = renderPalette();
    shelf("furniture");
    fireEvent.click(tile("palette-table"));
    expect(props.onAddFurniture).toHaveBeenCalledWith("table", expect.anything());
    expect(tile("palette-add")).toHaveAttribute("aria-expanded", "false");
  });

  it("names each piece's size in its tooltip", () => {
    renderPalette();
    shelf("furniture");
    expect(tile("palette-sofa").getAttribute("title")).toBe(
      'roomMap:palette.size {"name":"roomMap:furniture.type.sofa","width":"2.0","depth":"0.9"}',
    );
  });

  it("takes you to the TV there is instead of adding a second", () => {
    const props = renderPalette({ hasTv: true });
    shelf("screen");
    expect(tile("palette-tv")).toHaveAccessibleName("roomMap:palette.selectTv");
    fireEvent.click(tile("palette-tv"));
    expect(props.onSelectTv).toHaveBeenCalledTimes(1);
    expect(props.onAddTv).not.toHaveBeenCalled();
  });

  it("adds a strip from the screen shelf", () => {
    const props = renderPalette();
    shelf("screen");
    fireEvent.click(tile("palette-strip"));
    expect(props.onAddStrip).toHaveBeenCalledTimes(1);
  });

  it("has a Light shelf only in a room with a Hue side", () => {
    renderPalette();
    fireEvent.click(tile("palette-add"));
    expect(screen.queryByTestId("library-tab-light")).toBeNull();

    cleanup();
    const props = renderPalette({ hue: ready });
    shelf("light");
    fireEvent.click(tile("palette-zone"));
    expect(props.onAddZone).toHaveBeenCalledTimes(1);
  });

  it("sends a zone pressed with no area to the way to get one", () => {
    const onNavigateToDevices = vi.fn<() => void>();
    const props = renderPalette({
      hue: { state: { kind: "no-area", orphanedAreaId: false }, zoneCount: 0, lightCount: 0, channelsStatus: null, refreshing: false, onNavigateToDevices },
    });
    shelf("light");
    const zone = tile("palette-zone");
    expect(zone).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(zone);
    expect(props.onAddZone).not.toHaveBeenCalled();
    const ctas = screen.getAllByRole("button", { name: "roomMap:hueZones.areaState.noAreaCta" });
    expect(ctas.some((cta) => cta === document.activeElement)).toBe(true);
  });

  it("closes when Tab leaves it, handing focus back to Add", () => {
    renderPalette();
    shelf("furniture");
    fireEvent.blur(tile("palette-sofa"), { relatedTarget: null });
    expect(tile("palette-add")).toHaveAttribute("aria-expanded", "false");
    expect(tile("palette-add")).toHaveFocus();
  });

  it("opens on the shelf it was last left on", () => {
    renderPalette();
    shelf("screen");
    cleanup();
    renderPalette();
    fireEvent.click(tile("palette-add"));
    expect(tile("library-tab-screen")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("palette-strip")).toBeInTheDocument();
  });

  it("walks the cards with the arrows as one tab stop, and never adds", () => {
    const props = renderPalette();
    shelf("furniture");
    const cards = Array.from(tile("library-cards").querySelectorAll("button"));
    expect(cards.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    const sofa = tile("palette-sofa");
    sofa.focus();
    fireEvent.keyDown(sofa, { key: "ArrowRight" });
    expect(cards[1]).toHaveFocus();
    fireEvent.keyDown(cards[1]!, { key: "ArrowDown" });
    expect(cards[6]).toHaveFocus();
    const last = cards[cards.length - 1]!;
    fireEvent.keyDown(cards[6]!, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(sofa).toHaveFocus();
    expect(props.onAddFurniture).not.toHaveBeenCalled();
  });
});
