import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FurnitureModel } from "@/features/room-view/model/furnitureModel";
import type { FurniturePlacement } from "@/shared/contracts/roomMap";

import { FurnitureInspector } from "../FurnitureInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const table: FurniturePlacement = { id: "t", type: "table", x: 1, y: 1, width: 1, height: 0.6, label: "Work table" };
const coffee: FurnitureModel = { kind: "coffeeTable" };

function renderInspector(item: FurniturePlacement = table, model: FurnitureModel = coffee, modelChoices = true) {
  const handlers = {
    onUpdate: vi.fn<(patch: Partial<FurniturePlacement>) => void>(),
    onRename: vi.fn<(label: string) => void>(),
    onToggleLock: vi.fn<() => void>(),
    onDuplicate: vi.fn<() => void>(),
    onDelete: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
  };
  render(<FurnitureInspector item={item} model={model} autoModel={coffee} modelChoices={modelChoices} {...handlers} />);
  return handlers;
}

/** Opens a picker by its name and presses one of its options; a pick lands after the list's short exit. */
function choose(picker: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${picker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `) }));
  fireEvent.click(screen.getByRole("option", { name: option }));
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FurnitureInspector — model", () => {
  it("says when the piece is outside the room's shape", () => {
    const noop = () => {};
    const { unmount } = render(
      <FurnitureInspector
        item={table}
        model={coffee}
        autoModel={coffee}
        modelChoices
        outside
        onUpdate={noop}
        onRename={noop}
        onToggleLock={noop}
        onDuplicate={noop}
        onDelete={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("roomMap:inspector.outsideShape")).toBeTruthy();
    unmount();
    renderInspector();
    expect(screen.queryByText("roomMap:inspector.outsideShape")).toBeNull();
  });

  it("offers Auto, named for what it reads as, and the type's own models", () => {
    renderInspector();
    const picker = screen.getByRole("button", { name: /^roomMap:inspector\.modelLabel: / });
    expect(picker.textContent).toContain("roomMap:furniture.variant.coffee");
    fireEvent.click(picker);
    for (const v of ["desk", "coffee", "dining", "side"]) {
      expect(screen.getByRole("option", { name: `roomMap:furniture.variant.${v}` })).toBeDefined();
    }
  });

  it("keeps a pick and clears it on Auto", () => {
    const first = renderInspector();
    choose("roomMap:inspector.modelLabel", "roomMap:furniture.variant.desk");
    expect(first.onUpdate).toHaveBeenLastCalledWith({ variant: "desk" });

    cleanup();
    const second = renderInspector({ ...table, variant: "desk" }, { kind: "desk", screenX: null });
    choose("roomMap:inspector.modelLabel", 'roomMap:inspector.modelAuto {"model":"roomMap:furniture.variant.coffee"}');
    expect(second.onUpdate).toHaveBeenLastCalledWith({ variant: undefined });
  });

  it("clears a variant the new type does not take when the type changes", () => {
    const { onUpdate } = renderInspector({ ...table, variant: "desk", tone: "walnut" });
    choose("roomMap:inspector.furnitureTypeLabel", "roomMap:furniture.type.storage");
    expect(onUpdate).toHaveBeenLastCalledWith({ type: "storage", variant: undefined, tone: "walnut", topMeters: undefined });
  });
});

describe("FurnitureInspector — tone and size", () => {
  it("picks a tone from the type's palette and clears it on Default", () => {
    const { onUpdate } = renderInspector();
    fireEvent.click(screen.getByRole("button", { name: /^roomMap:inspector\.toneLabel: / }));
    expect(screen.queryByRole("radio", { name: "roomMap:furniture.tone.slate" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:furniture.tone.walnut" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ tone: "walnut" });
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:inspector.toneDefault" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ tone: undefined });
  });

  it("labels the footprint's second side Depth, and offers the piece's height empty by default", () => {
    renderInspector();
    expect(screen.getByLabelText("roomMap:inspector.depthLabel")).toBeDefined();
    const height = screen.getByLabelText("roomMap:inspector.heightLabel") as HTMLInputElement;
    expect(height.value).toBe("");
    expect(height.placeholder).toBe("0.43");
  });
});

describe("FurnitureInspector — a build without the 3D room", () => {
  it("offers no model, tone or height, since nothing would draw them", () => {
    renderInspector(table, coffee, false);
    expect(screen.queryByRole("button", { name: /^roomMap:inspector\.modelLabel: / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^roomMap:inspector\.toneLabel: / })).toBeNull();
    expect(screen.queryByLabelText("roomMap:inspector.heightLabel")).toBeNull();
    expect(screen.getByLabelText("roomMap:inspector.depthLabel")).toBeDefined();
  });
});

describe("FurnitureInspector — position and rotation", () => {
  const field = (name: string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
  const enter = (input: HTMLInputElement, value: string) => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("takes a typed X and Y", () => {
    const { onUpdate } = renderInspector();
    expect(field("roomMap:inspector.xLabel").value).toBe("1.00");
    enter(field("roomMap:inspector.xLabel"), "2.4");
    expect(onUpdate).toHaveBeenLastCalledWith({ x: 2.4 });
    enter(field("roomMap:inspector.yLabel"), "0,5");
    expect(onUpdate).toHaveBeenLastCalledWith({ y: 0.5 });
  });

  it("wraps a rotation typed past a full turn or below zero", () => {
    const { onUpdate } = renderInspector({ ...table, rotation: 350 });
    enter(field("roomMap:inspector.furnitureRotationLabel"), "-90");
    expect(onUpdate).toHaveBeenLastCalledWith({ rotation: 270 });
    enter(field("roomMap:inspector.furnitureRotationLabel"), "370");
    expect(onUpdate).toHaveBeenLastCalledWith({ rotation: 10 });
  });

  it("holds every number, the name and the delete while the piece is locked", () => {
    renderInspector({ ...table, locked: true });
    for (const name of [
      "roomMap:inspector.xLabel",
      "roomMap:inspector.yLabel",
      "roomMap:inspector.widthLabel",
      "roomMap:inspector.depthLabel",
      "roomMap:inspector.heightLabel",
      "roomMap:inspector.furnitureRotationLabel",
    ]) {
      expect(field(name)).toBeDisabled();
    }
    expect(screen.getByRole("textbox", { name: "roomMap:inspector.furnitureNameLabel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "roomMap:objectPanel.delete" })).toBeDisabled();
  });
});

describe("FurnitureInspector — name and actions", () => {
  it("renames on Enter, and puts the name back on Escape or when emptied", () => {
    const { onRename } = renderInspector();
    const name = screen.getByRole("textbox", { name: "roomMap:inspector.furnitureNameLabel" }) as HTMLInputElement;
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Desk by the window" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onRename).toHaveBeenLastCalledWith("Desk by the window");

    fireEvent.change(name, { target: { value: "Something else" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(name.value).toBe("Work table");
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.blur(name);
    expect(name.value).toBe("Work table");
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("locks, duplicates, deletes and closes from the row's end", () => {
    const handlers = renderInspector();
    const lock = screen.getByRole("button", { name: "roomMap:objectPanel.lock" });
    expect(lock).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(lock);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:contextMenu.duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "roomMap:objectPanel.delete" }));
    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.close" }));
    expect(handlers.onToggleLock).toHaveBeenCalledTimes(1);
    expect(handlers.onDuplicate).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
