import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EFFECT_IDS } from "@/shared/contracts/effects";
import { DEFAULT_EFFECT, type EffectPayload } from "@/shared/contracts/mode";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { EffectPanel } from "../EffectPanel";

describe("EffectPanel", () => {
  it("sends the whole effect with the one field changed", () => {
    const onChange = vi.fn<(next: EffectPayload) => void>();
    render(<EffectPanel effect={{ ...DEFAULT_EFFECT }} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("effect-breathe"));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_EFFECT, id: EFFECT_IDS.BREATHE });
    expect(screen.getByTestId("effect-breathe")).toHaveAttribute("aria-checked", "true");
  });

  // What runs is shown when it changes elsewhere — the tray, the popup, another window.
  it("follows the running effect", () => {
    const { rerender } = render(<EffectPanel effect={{ ...DEFAULT_EFFECT }} onChange={() => {}} />);
    rerender(<EffectPanel effect={{ ...DEFAULT_EFFECT, id: EFFECT_IDS.CYCLE }} onChange={() => {}} />);
    expect(screen.getByTestId("effect-cycle")).toHaveAttribute("aria-checked", "true");
  });
});
