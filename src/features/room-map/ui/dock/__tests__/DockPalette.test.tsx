import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FurnitureType } from "@/shared/contracts/roomMap";

import type { LibraryDrop } from "../../../model/libraryDrop";
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
// The drawer is its own chunk: the first open waits for it.
const openLibrary = async () => {
  fireEvent.click(tile("palette-add"));
  await screen.findByRole("dialog", { name: "roomMap:library.label" });
};
const shelf = async (tab: "furniture" | "light" | "screen") => {
  if (tile("palette-add").getAttribute("aria-expanded") !== "true") await openLibrary();
  fireEvent.click(tile(`library-tab-${tab}`));
};
const ready: PaletteHueArea = { state: { kind: "ready", orphanedAreaId: false }, zoneCount: 2, lightCount: 4, channelsStatus: null, refreshing: false };

describe("DockPalette", () => {
  it("is one row: Add, the templates where the editor has them, and the Hue area's state", async () => {
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

  it("opens the library from Add, its own press closing it", async () => {
    renderPalette();
    const add = tile("palette-add");
    expect(add).toHaveAttribute("aria-haspopup", "dialog");
    await openLibrary();
    expect(add).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("radio", { checked: true })).toHaveFocus();
    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "false");
  });

  it("adds a piece of the pressed type and closes the library", async () => {
    const props = renderPalette();
    await shelf("furniture");
    fireEvent.click(tile("palette-table"));
    expect(props.onAddFurniture).toHaveBeenCalledWith("table", expect.anything());
    expect(tile("palette-add")).toHaveAttribute("aria-expanded", "false");
  });

  it("names each piece's size in its tooltip", async () => {
    renderPalette();
    await shelf("furniture");
    expect(tile("palette-sofa").getAttribute("title")).toBe(
      'roomMap:palette.size {"name":"roomMap:furniture.type.sofa","width":"2.0","depth":"0.9"}',
    );
  });

  it("takes you to the TV there is instead of adding a second", async () => {
    const props = renderPalette({ hasTv: true });
    await shelf("screen");
    expect(tile("palette-tv")).toHaveAccessibleName("roomMap:palette.selectTv");
    fireEvent.click(tile("palette-tv"));
    expect(props.onSelectTv).toHaveBeenCalledTimes(1);
    expect(props.onAddTv).not.toHaveBeenCalled();
  });

  it("adds a strip from the screen shelf", async () => {
    const props = renderPalette();
    await shelf("screen");
    fireEvent.click(tile("palette-strip"));
    expect(props.onAddStrip).toHaveBeenCalledTimes(1);
  });

  it("has a Light shelf only in a room with a Hue side", async () => {
    renderPalette();
    await openLibrary();
    expect(screen.queryByTestId("library-tab-light")).toBeNull();

    cleanup();
    const props = renderPalette({ hue: ready });
    await shelf("light");
    fireEvent.click(tile("palette-zone"));
    expect(props.onAddZone).toHaveBeenCalledTimes(1);
  });

  it("sends a zone pressed with no area to the way to get one", async () => {
    const onNavigateToDevices = vi.fn<() => void>();
    const props = renderPalette({
      hue: { state: { kind: "no-area", orphanedAreaId: false }, zoneCount: 0, lightCount: 0, channelsStatus: null, refreshing: false, onNavigateToDevices },
    });
    await shelf("light");
    const zone = tile("palette-zone");
    expect(zone).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(zone);
    expect(props.onAddZone).not.toHaveBeenCalled();
    const ctas = screen.getAllByRole("button", { name: "roomMap:hueZones.areaState.noAreaCta" });
    expect(ctas.some((cta) => cta === document.activeElement)).toBe(true);
  });

  it("closes when Tab leaves it, handing focus back to Add", async () => {
    renderPalette();
    await shelf("furniture");
    fireEvent.blur(tile("palette-sofa"), { relatedTarget: null });
    expect(tile("palette-add")).toHaveAttribute("aria-expanded", "false");
    expect(tile("palette-add")).toHaveFocus();
  });

  it("opens on the shelf it was last left on", async () => {
    renderPalette();
    await shelf("screen");
    cleanup();
    renderPalette();
    await openLibrary();
    expect(tile("library-tab-screen")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("palette-strip")).toBeInTheDocument();
  });

  it("walks the cards with the arrows as one tab stop, and never adds", async () => {
    const props = renderPalette();
    await shelf("furniture");
    const cards = Array.from(tile("library-cards").querySelectorAll("button"));
    expect(cards.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    const sofa = tile("palette-sofa");
    act(() => sofa.focus());
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

  describe("dragging a card out", () => {
    const fakeDrop = (lands = true): LibraryDrop => ({ hover: vi.fn<LibraryDrop["hover"]>(() => true), land: vi.fn<LibraryDrop["land"]>(() => lands), cancel: vi.fn<() => void>() });
    const pointer = (type: string, x: number, y: number) =>
      act(() => {
        window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, buttons: type === "pointermove" ? 1 : 0, bubbles: true }));
      });
    const press = (testId: string) => fireEvent.pointerDown(tile(testId), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });

    it("becomes a drag past the click slop, closing the drawer, and lands where it is let go", async () => {
      const drop = fakeDrop();
      const props = renderPalette({ drop });
      await shelf("furniture");
      press("palette-sofa");
      pointer("pointermove", 13, 12);
      expect(drop.hover).not.toHaveBeenCalled();
      pointer("pointermove", 200, 120);
      expect(drop.hover).toHaveBeenCalledWith({ kind: "furniture", type: "sofa" }, 200, 120);
      expect(tile("palette-add")).toHaveAttribute("aria-expanded", "false");
      expect(document.documentElement).toHaveAttribute("data-library-drag");
      pointer("pointerup", 210, 130);
      expect(drop.land).toHaveBeenCalledWith({ kind: "furniture", type: "sofa" }, 210, 130);
      expect(document.documentElement).not.toHaveAttribute("data-library-drag");
      // The click the drag ends with is not a second add.
      fireEvent.click(tile("palette-sofa"));
      expect(props.onAddFurniture).not.toHaveBeenCalled();
    });

    it("cancels on Escape, ahead of the editor, and gives the keys back to Add", async () => {
      const drop = fakeDrop();
      const outer = vi.fn<(event: KeyboardEvent) => void>();
      document.addEventListener("keydown", outer);
      renderPalette({ drop });
      await shelf("furniture");
      press("palette-sofa");
      pointer("pointermove", 200, 120);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(drop.cancel).toHaveBeenCalledOnce();
      expect(outer).not.toHaveBeenCalled();
      expect(tile("palette-add")).toHaveFocus();
      pointer("pointerup", 200, 120);
      expect(drop.land).not.toHaveBeenCalled();
      document.removeEventListener("keydown", outer);
    });

    it("hands the keys back to Add when the drop finds no floor", async () => {
      renderPalette({ drop: fakeDrop(false) });
      await shelf("furniture");
      press("palette-sofa");
      pointer("pointermove", 200, 120);
      pointer("pointerup", 200, 120);
      expect(tile("palette-add")).toHaveFocus();
      // The drag's click guard lasts until the next task; no click came to spend it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("says where letting go would add nothing", async () => {
      const drop = fakeDrop();
      drop.hover = vi.fn<LibraryDrop["hover"]>(() => false);
      renderPalette({ drop });
      await shelf("furniture");
      press("palette-sofa");
      pointer("pointermove", 200, 120);
      expect(document.documentElement).toHaveAttribute("data-library-drag", "refused");
      pointer("pointerup", 200, 120);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("lets go of a card when the window loses the pointer or its focus", async () => {
      const drop = fakeDrop();
      renderPalette({ drop });
      await shelf("furniture");
      press("palette-sofa");
      pointer("pointermove", 200, 120);
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      expect(drop.cancel).toHaveBeenCalledOnce();
      expect(document.documentElement).not.toHaveAttribute("data-library-drag");

      press("palette-chair");
      pointer("pointermove", 200, 120);
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 220, clientY: 130, pointerId: 1, buttons: 0 }));
      });
      expect(drop.cancel).toHaveBeenCalledTimes(2);
      pointer("pointerup", 220, 130);
      expect(drop.land).not.toHaveBeenCalled();
    });

    it("keeps a press that stays put a click, and a placed TV unheld", async () => {
      const drop = fakeDrop();
      const props = renderPalette({ drop, hasTv: true });
      await shelf("furniture");
      press("palette-table");
      pointer("pointermove", 12, 11);
      pointer("pointerup", 12, 11);
      fireEvent.click(tile("palette-table"));
      expect(props.onAddFurniture).toHaveBeenCalledWith("table", expect.anything());
      await shelf("screen");
      press("palette-tv");
      pointer("pointermove", 200, 120);
      expect(drop.hover).not.toHaveBeenCalled();
      pointer("pointerup", 200, 120);
    });
  });
});
