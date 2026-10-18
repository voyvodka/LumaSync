import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EFFECT_RANGES, type PaletteId } from "@/shared/contracts/effects";
import type { EffectColor, EffectPayload } from "@/shared/contracts/mode";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PaletteStrip } from "../PaletteStrip";

const [MIN_COLORS, MAX_COLORS] = EFFECT_RANGES.colors;
const red = { r: 255, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 255 };
const custom = (colors: EffectColor[]): EffectPayload => ({ id: "wave", speed: 0.5, brightness: 1, palette: "custom", colors });

function openColours(colors: EffectColor[]) {
  const onPick = vi.fn<(palette: PaletteId, colors?: EffectColor[]) => void>();
  const view = render(<PaletteStrip effect={custom(colors)} onPick={onPick} />);
  fireEvent.click(screen.getByTestId("palette-edit"));
  const editor = screen.getByTestId("custom-colors");
  const chips = () => [...editor.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  return { onPick, editor, chips, unmount: view.unmount };
}

describe("PaletteStrip — your colours", () => {
  it("picking the user's palette hands over the colours it plays", () => {
    const onPick = vi.fn<(palette: PaletteId, colors?: EffectColor[]) => void>();
    render(<PaletteStrip effect={{ id: "wave", speed: 0.5, brightness: 1 }} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("palette-custom"));
    expect(onPick).toHaveBeenCalledWith("custom", expect.any(Array));
    expect(onPick.mock.calls[0]![1]!.length).toBeGreaterThanOrEqual(MIN_COLORS);
  });

  it("adds a colour as a copy of the one selected", () => {
    const { onPick, editor, chips } = openColours([red, blue]);
    expect(chips()).toHaveLength(2);
    expect(chips()[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(editor).getByRole("button", { name: "lights:effect.addColor" }));
    expect(onPick).toHaveBeenLastCalledWith("custom", [red, blue, red]);

  });

  it("removes the selected colour", () => {
    const { onPick, editor, chips } = openColours([red, blue]);
    fireEvent.click(chips()[1]!);
    expect(chips()[1]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(editor).getByRole("button", { name: "lights:effect.removeColor" }));
    expect(onPick).toHaveBeenLastCalledWith("custom", [red]);
  });

  it("keeps at least the fewest colours and adds none past the most", () => {
    const fewest = openColours(Array.from({ length: MIN_COLORS }, () => red));
    expect(within(fewest.editor).queryByRole("button", { name: "lights:effect.removeColor" })).toBeNull();
    fewest.unmount();

    const most = openColours(Array.from({ length: MAX_COLORS }, () => red)).editor;
    expect(within(most).queryByRole("button", { name: "lights:effect.addColor" })).toBeNull();
  });
});
