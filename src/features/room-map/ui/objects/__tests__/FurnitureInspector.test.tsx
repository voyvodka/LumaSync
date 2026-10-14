import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FurnitureModel } from "@/features/room-view/model/furnitureModel";
import type { FurniturePlacement } from "@/shared/contracts/roomMap";

import { FurnitureInspector } from "../FurnitureInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const table: FurniturePlacement = { id: "t", type: "table", x: 1, y: 1, width: 1, height: 0.6, label: "Table" };
const coffee: FurnitureModel = { kind: "coffeeTable" };

function renderInspector(item: FurniturePlacement = table, model: FurnitureModel = coffee) {
  const onUpdate = vi.fn<(patch: Partial<FurniturePlacement>) => void>();
  render(
    <FurnitureInspector
      item={item}
      model={model}
      autoModel={coffee}
      onUpdate={onUpdate}
      onToggleLock={vi.fn<() => void>()}
      onRename={vi.fn<(label: string) => void>()}
    />,
  );
  return { onUpdate };
}

describe("FurnitureInspector — model", () => {
  beforeEach(() => cleanup());

  it("offers Auto, named for what it reads as, and the type's own models", () => {
    renderInspector();
    const auto = screen.getByRole("radio", { name: /roomMap:inspector\.modelAutoAria/ });
    expect(auto.textContent).toContain("roomMap:furniture.variant.coffee");
    expect(auto).toHaveAttribute("aria-checked", "true");
    for (const v of ["desk", "coffee", "dining", "side"]) {
      expect(screen.getByRole("radio", { name: `roomMap:furniture.variant.${v}` })).toBeDefined();
    }
  });

  it("keeps a pick and clears it on Auto", () => {
    const { onUpdate } = renderInspector();
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:furniture.variant.desk" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ variant: "desk" });

    cleanup();
    const second = renderInspector({ ...table, variant: "desk" }, { kind: "desk", screenX: null });
    fireEvent.click(screen.getByRole("radio", { name: /roomMap:inspector\.modelAutoAria/ }));
    expect(second.onUpdate).toHaveBeenLastCalledWith({ variant: undefined });
  });

  it("clears a variant the new type does not take when the type changes", () => {
    const { onUpdate } = renderInspector({ ...table, variant: "desk", tone: "walnut" });
    fireEvent.change(screen.getByLabelText("roomMap:inspector.furnitureTypeLabel"), { target: { value: "storage" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ type: "storage", variant: undefined, tone: "walnut" });
  });
});

describe("FurnitureInspector — tone and size", () => {
  beforeEach(() => cleanup());

  it("picks a tone from the type's palette and clears it on Default", () => {
    const { onUpdate } = renderInspector();
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
