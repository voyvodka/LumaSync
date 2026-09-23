import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SolidColorPanel } from "../SolidColorPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderPanel(incoming: { r: number; g: number; b: number }) {
  render(
    <SolidColorPanel
      incoming={{ ...incoming, brightness: 1 }}
      disabled={false}
      onCommit={() => {}}
    />,
  );
}

describe("SolidColorPanel hex readout", () => {
  it("shows the uppercase hex for an integer colour", () => {
    renderPanel({ r: 168, g: 173, b: 76 });
    expect(screen.getByText("#A8AD4C")).toBeTruthy();
  });

  // Floored before the panel moved onto the shared helper, reading `#7F00FE`.
  it("rounds a fractional channel instead of flooring it", () => {
    renderPanel({ r: 127.6, g: 0, b: 254.5 });
    expect(screen.getByText("#8000FF")).toBeTruthy();
  });
});
