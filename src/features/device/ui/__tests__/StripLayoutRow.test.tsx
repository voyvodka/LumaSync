import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LedStrip } from "@/shared/contracts/strips";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { StripLayoutRow } from "../StripLayoutRow";

const laidOut = {
  id: "a",
  enabled: true,
  hardware: {},
  layout: { counts: { top: 20, right: 10, bottom: 20, left: 10 }, totalLeds: 60 },
} as unknown as LedStrip;

describe("StripLayoutRow", () => {
  // With two screens, which one the layout is drawn on is part of the value; it is picked in LED Setup.
  it("names the captured display when there is more than one to tell apart", () => {
    render(<StripLayoutRow strip={laidOut} primary={false} display="LG UltraFine" onOpen={() => {}} />);
    expect(screen.getByTestId("strip-layout")).toHaveTextContent("LG UltraFine · device:strip.layoutValue");
  });

  it("says only the layout with one display, and nothing about a display before one is laid out", () => {
    const { rerender } = render(<StripLayoutRow strip={laidOut} primary={false} onOpen={() => {}} />);
    expect(screen.getByTestId("strip-layout")).not.toHaveTextContent("·");
    rerender(<StripLayoutRow strip={{ ...laidOut, layout: undefined }} primary display="LG UltraFine" onOpen={() => {}} />);
    expect(screen.getByTestId("strip-layout")).toHaveTextContent("device:strip.layoutNone");
    expect(screen.getByTestId("strip-layout")).not.toHaveTextContent("LG UltraFine");
  });
});
