import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageLayer } from "@/shared/contracts/roomMap";

import { ImageLayerInspector } from "../ImageLayerInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const layer: ImageLayer = { id: "img", path: "/plan.png", label: "Plan", offsetX: 80, offsetY: 160, scale: 1 };

function renderInspector(overrides: Partial<ImageLayer> = {}) {
  const onUpdate = vi.fn<(patch: Partial<ImageLayer>) => void>();
  render(
    <ImageLayerInspector
      layer={{ ...layer, ...overrides }}
      onUpdate={onUpdate}
      onToggleLock={vi.fn<() => void>()}
      onRename={vi.fn<(label: string) => void>()}
    />,
  );
  return { onUpdate };
}

const field = (name: string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const enter = (input: HTMLInputElement, value: string) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("ImageLayerInspector — position", () => {
  beforeEach(() => cleanup());

  it("reads the canvas offset in metres and writes a typed metre back as canvas pixels", () => {
    const { onUpdate } = renderInspector();
    expect(field("roomMap:inspector.xLabel").value).toBe("1.00");
    expect(field("roomMap:inspector.yLabel").value).toBe("2.00");
    enter(field("roomMap:inspector.xLabel"), "0.5");
    expect(onUpdate).toHaveBeenLastCalledWith({ offsetX: 40 });
  });
});

describe("ImageLayerInspector — scale", () => {
  beforeEach(() => cleanup());

  it("scales both sides together while the proportions are locked, keeping their ratio", () => {
    const { onUpdate } = renderInspector({ scaleX: 2, scaleY: 1 });
    expect(screen.queryByRole("spinbutton", { name: "roomMap:inspector.imageScaleXLabel" })).toBeNull();
    enter(field("roomMap:inspector.imageScaleLabel"), "4");
    expect(onUpdate).toHaveBeenLastCalledWith({ scaleX: 4, scaleY: 2 });
  });

  it("offers each side on its own once the proportions are unlocked", () => {
    const { onUpdate } = renderInspector({ scaleX: 2, scaleY: 1, aspectLocked: false });
    enter(field("roomMap:inspector.imageScaleYLabel"), "1.5");
    expect(onUpdate).toHaveBeenLastCalledWith({ scaleX: 2, scaleY: 1.5 });
  });

  it("toggles the proportions lock, and evens them out only when they differ", () => {
    const { onUpdate } = renderInspector({ scaleX: 2, scaleY: 1 });
    const lock = screen.getByRole("button", { name: "roomMap:inspector.imageAspectLocked" });
    expect(lock).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(lock);
    expect(onUpdate).toHaveBeenLastCalledWith({ aspectLocked: false });
    fireEvent.click(screen.getByRole("button", { name: "roomMap:inspector.imageAspectReset" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ scaleX: 2, scaleY: 2 });

    cleanup();
    renderInspector({ scaleX: 1.5, scaleY: 1.5 });
    expect(screen.getByRole("button", { name: "roomMap:inspector.imageAspectReset" })).toBeDisabled();
  });

  it("holds position and scale while the layer is locked", () => {
    renderInspector({ locked: true });
    expect(field("roomMap:inspector.xLabel")).toBeDisabled();
    expect(field("roomMap:inspector.imageScaleLabel")).toBeDisabled();
    expect(screen.getByRole("button", { name: "roomMap:inspector.imageAspectLocked" })).toBeDisabled();
  });
});
