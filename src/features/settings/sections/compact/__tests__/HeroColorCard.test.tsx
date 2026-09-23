import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HeroColorCard } from "../HeroColorCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderCard(rgb: { r: number; g: number; b: number }) {
  render(<HeroColorCard rgb={rgb} disabled={false} sublabel="sub" onChange={() => {}} />);
}

// The compact hero formatted channels with no rounding or clamping, so a
// fractional or out-of-range channel printed a malformed label (`#7F.999…`,
// `#-312C2C`). It now shares the helper every other hex readout uses.
describe("HeroColorCard hex label", () => {
  it("shows the uppercase hex for an integer colour", () => {
    renderCard({ r: 168, g: 173, b: 76 });
    expect(screen.getByText("#A8AD4C")).toBeTruthy();
  });

  it("rounds fractional channels", () => {
    renderCard({ r: 127.6, g: 0, b: 254.5 });
    expect(screen.getByText("#8000FF")).toBeTruthy();
  });

  it("clamps out-of-range channels", () => {
    renderCard({ r: -3, g: 300, b: 44 });
    expect(screen.getByText("#00FF2C")).toBeTruthy();
  });
});
