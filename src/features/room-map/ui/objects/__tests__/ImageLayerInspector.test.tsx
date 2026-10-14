import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageLayer } from "@/shared/contracts/roomMap";

import { ImageLayerInspector } from "../ImageLayerInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const layer: ImageLayer = { id: "img", path: "/plan.png", label: "Plan", offsetX: 80, offsetY: 160, scale: 1 };

function renderInspector(overrides: Partial<ImageLayer> = {}) {
  const handlers = {
    onUpdate: vi.fn<(patch: Partial<ImageLayer>) => void>(),
    onToggleLock: vi.fn<() => void>(),
    onRename: vi.fn<(label: string) => void>(),
    onDelete: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
  };
  render(<ImageLayerInspector layer={{ ...layer, ...overrides }} {...handlers} />);
  return handlers;
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
    const lock = screen.getByRole("button", { name: "roomMap:inspector.imageAspectLock" });
    expect(lock).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(lock);
    expect(onUpdate).toHaveBeenLastCalledWith({ aspectLocked: false });
    fireEvent.click(screen.getByRole("button", { name: "roomMap:inspector.imageAspectReset" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ scaleX: 2, scaleY: 2 });

    cleanup();
    renderInspector({ scaleX: 1.5, scaleY: 1.5 });
    expect(screen.getByRole("button", { name: "roomMap:inspector.imageAspectReset" })).toBeDisabled();
  });

  it("holds position, scale and opacity while the layer is locked", () => {
    renderInspector({ locked: true });
    expect(field("roomMap:inspector.xLabel")).toBeDisabled();
    expect(field("roomMap:inspector.imageScaleLabel")).toBeDisabled();
    expect(screen.getByRole("button", { name: "roomMap:inspector.imageAspectLock" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "roomMap:inspector.imageOpacityLabel" })).toBeDisabled();
  });
});

describe("ImageLayerInspector — opacity", () => {
  beforeEach(() => cleanup());

  it("writes a whole percentage from the slider and reads it back", () => {
    const { onUpdate } = renderInspector({ opacity: 40 });
    const slider = screen.getByRole("slider", { name: "roomMap:inspector.imageOpacityLabel" });
    expect(slider).toHaveValue("40");
    expect(screen.getByText("40%")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "65" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ opacity: 65 });
  });
});
