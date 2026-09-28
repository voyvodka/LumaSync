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
