import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PopupEffectRow } from "../PopupEffectRow";

describe("PopupEffectRow", () => {
  it("names the running effect and retunes its brightness", () => {
    const onBrightness = vi.fn<(brightness: number) => void>();
    render(<PopupEffectRow effect={{ id: "aurora", speed: 0.5, brightness: 0.6 }} onBrightness={onBrightness} />);
    expect(screen.getByText("lights:effect.names.aurora")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "25" } });
    expect(onBrightness).toHaveBeenLastCalledWith(0.25);
    expect(screen.getByText("25%")).toBeInTheDocument();
  });
});
