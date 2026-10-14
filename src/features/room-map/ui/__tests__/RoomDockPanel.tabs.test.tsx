import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { RoomDockPanel } from "../RoomDockPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../ObjectsTab", () => ({ ObjectsTab: () => <div data-testid="objects-tab" /> }));
vi.mock("../HueZonesTab", () => ({ HueZonesTab: () => <div data-testid="hue-zones-tab" /> }));

const base = {
  config: DEFAULT_ROOM_MAP,
  selectedId: null,
  onSelect: vi.fn<(id: string | null) => void>(),
  onDelete: vi.fn<(id: string) => void>(),
  onRenameFurniture: vi.fn<(id: string, label: string) => void>(),
  onToggleLock: vi.fn<(id: string) => void>(),
};

const hueZoneEditing = {
  hueZones: [],
  onSelectHueZone: vi.fn<(zoneId: string | null) => void>(),
  onAddHueZone: vi.fn<() => void>(),
  onDeleteHueZone: vi.fn<(zoneId: string) => void>(),
  onRenameHueZone: vi.fn<(zoneId: string, name: string) => void>(),
};

describe("RoomDockPanel — tabs", () => {
  it("ties the open tab and its panel to each other", () => {
    render(<RoomDockPanel {...base} {...hueZoneEditing} />);
    const objects = screen.getByRole("tab", { name: "roomMap:objectPanel.objectsTab" });
    const panel = screen.getByRole("tabpanel");

    expect(objects).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", objects.id);
  });

  it("has one tab stop, on the open tab", () => {
    render(<RoomDockPanel {...base} {...hueZoneEditing} />);
    const [objects, hue] = screen.getAllByRole("tab");

    expect(objects).toHaveAttribute("tabindex", "0");
    expect(hue).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with the arrows and opens a tab only on Enter or a click", () => {
    render(<RoomDockPanel {...base} {...hueZoneEditing} />);
    const [objects, hue] = screen.getAllByRole("tab");
    objects!.focus();

    fireEvent.keyDown(objects!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(hue);
    expect(screen.getByTestId("objects-tab")).toBeInTheDocument();

    act(() => hue!.click());
    expect(screen.getByTestId("hue-zones-tab")).toBeInTheDocument();
    expect(hue).toHaveAttribute("tabindex", "0");
  });

  it("falls back to Objects when zone editing goes away under an open Hue tab", () => {
    const { rerender } = render(<RoomDockPanel {...base} {...hueZoneEditing} />);
    act(() => screen.getAllByRole("tab")[1]!.click());

    rerender(<RoomDockPanel {...base} />);

    expect(screen.getByTestId("objects-tab")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "roomMap:objectPanel.objectsTab" })).toHaveAttribute("tabindex", "0");
  });
});
