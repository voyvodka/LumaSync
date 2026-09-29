import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EffectPayload } from "@/shared/contracts/mode";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { EffectControls } from "../EffectControls";

const wave: EffectPayload = { id: "wave", speed: 0.5, brightness: 1 };

function renderFull(effect: EffectPayload = wave) {
  const onChange = vi.fn<(next: EffectPayload) => void>();
  const view = render(<EffectControls variant="full" effect={effect} onChange={onChange} />);
  return { onChange, ...view };
}

describe("EffectControls — full", () => {
  it("shows every effect as a tile, the running one checked", () => {
    renderFull();
    expect(screen.getAllByRole("radio").filter((r) => r.dataset.testid?.startsWith("effect-")).length).toBeGreaterThanOrEqual(16);
    expect(screen.getByTestId("effect-wave")).toHaveAttribute("aria-checked", "true");
  });

  it("picking a tile starts that effect in its own palette, keeping speed and brightness", () => {
    const { onChange } = renderFull({ ...wave, speed: 0.8, palette: "ocean" });
    fireEvent.click(screen.getByTestId("effect-candle"));
    expect(onChange).toHaveBeenLastCalledWith({ id: "candle", speed: 0.8, brightness: 1 });
  });

  it("picking a palette plays it", () => {
    const { onChange } = renderFull();
    fireEvent.click(screen.getByTestId("palette-sunset"));
    expect(onChange).toHaveBeenLastCalledWith({ ...wave, palette: "sunset" });
    expect(screen.getByTestId("palette-sunset")).toHaveAttribute("aria-checked", "true");
  });

  it("asks only what the running effect declares", () => {
    const { rerender } = renderFull();
    expect(screen.getByTestId("effect-speed")).toBeInTheDocument();
    expect(screen.getByText("lights:effect.sizeFor.wave")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "lights:effect.direction" })).toBeInTheDocument();
    expect(screen.queryByTestId("effect-intensity")).toBeNull();

    rerender(<EffectControls variant="full" effect={{ id: "candle", speed: 0.5, brightness: 1 }} onChange={() => {}} />);
    expect(screen.getByText("lights:effect.intensityFor.candle")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "lights:effect.direction" })).toBeNull();

    rerender(<EffectControls variant="full" effect={{ id: "sunrise", speed: 0.5, brightness: 1 }} onChange={() => {}} />);
    expect(screen.getByTestId("effect-duration")).toBeInTheDocument();
    expect(screen.queryByTestId("effect-speed")).toBeNull();
    // Sunrise draws its own colours: no palettes to pick.
    expect(screen.queryByTestId("palette-rainbow")).toBeNull();
  });

  // The pen keeps its place either way, so picking "Your colours" never shifts the strip.
  it("offers the colours only once the user's own palette plays", () => {
    const { rerender } = renderFull();
    expect(screen.getByTestId("palette-edit")).toBeDisabled();
    rerender(
      <EffectControls
        variant="full"
        effect={{ ...wave, palette: "custom", colors: [{ r: 10, g: 20, b: 30 }] }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("palette-edit")).toBeEnabled();
  });

  // Said as words too, not only drawn: a title never reaches a keyboard or a screen reader.
  it("marks the effects that are best on a strip", () => {
    renderFull();
    expect(screen.getByTestId("effect-comet")).toHaveTextContent("lights:effect.bestOnStripShort");
    expect(screen.getByTestId("effect-candle")).not.toHaveTextContent("lights:effect.bestOnStripShort");
  });

  it("changing the direction sends it", () => {
    const { onChange } = renderFull();
    fireEvent.click(screen.getByTestId("effect-direction-around"));
    expect(onChange).toHaveBeenLastCalledWith({ ...wave, direction: "around" });
  });

  // What runs is shown when it changes elsewhere — the tray, the popup, another window.
  it("follows the running effect", () => {
    const { rerender } = renderFull();
    rerender(<EffectControls variant="full" effect={{ ...wave, id: "cycle" }} onChange={() => {}} />);
    expect(screen.getByTestId("effect-cycle")).toHaveAttribute("aria-checked", "true");
  });
});

describe("EffectControls — a new effect's settings", () => {
  it("fades in the settings the new effect brings, and keeps the one both share", () => {
    const view = render(<EffectControls variant="full" effect={{ id: "sunrise", speed: 0.5, brightness: 1 }} onChange={() => {}} />);
    view.rerender(<EffectControls variant="full" effect={{ id: "plasma", speed: 0.5, brightness: 1 }} onChange={() => {}} />);
    const cellOf = (testId: string) => screen.getByTestId(testId).closest("[data-flip-id]");
    expect(cellOf("effect-speed")).toHaveAttribute("data-entering");
    expect(cellOf("effect-brightness")).not.toHaveAttribute("data-entering");
    expect(screen.getByTestId("palette-party").closest("[data-flip-id]")).toHaveAttribute("data-entering");
  });

  it("leaves the page where it is after a pick: the settings grow in place, nothing scrolls", () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<EffectControls variant="full" effect={{ id: "sunrise", speed: 0.5, brightness: 1 }} onChange={() => {}} />);
      fireEvent.click(screen.getByTestId("effect-plasma"));
      vi.advanceTimersByTime(1000);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
      vi.useRealTimers();
    }
  });
});

describe("EffectControls — a palette change", () => {
  it("keeps each tile's old picture on top to fade, and lets it go when the fade ends", () => {
    const wave: EffectPayload = { id: "wave", speed: 0.5, brightness: 1, palette: "rainbow" };
    const view = render(<EffectControls variant="full" effect={wave} onChange={() => {}} />);
    const tile = screen.getByTestId("effect-wave");
    expect(tile.querySelectorAll("span[style]")).toHaveLength(1);
    view.rerender(<EffectControls variant="full" effect={{ ...wave, palette: "ocean" }} onChange={() => {}} />);
    const layers = tile.querySelectorAll<HTMLElement>("span[style]");
    expect(layers).toHaveLength(2);
    fireEvent.animationEnd(layers[1]!);
    expect(tile.querySelectorAll("span[style]")).toHaveLength(1);
  });
});

describe("EffectControls — compact", () => {
  it("picks from a list instead of a gallery, with speed and brightness only", () => {
    render(<EffectControls variant="compact" effect={wave} onChange={() => {}} />);
    expect(screen.getByTestId("effect-picker")).toHaveTextContent("lights:effect.names.wave");
    expect(screen.queryByTestId("effect-candle")).toBeNull();
    expect(screen.getByTestId("effect-speed")).toBeInTheDocument();
    expect(screen.getByTestId("effect-brightness")).toBeInTheDocument();
    expect(screen.queryByText("lights:effect.sizeFor.wave")).toBeNull();
  });
});
