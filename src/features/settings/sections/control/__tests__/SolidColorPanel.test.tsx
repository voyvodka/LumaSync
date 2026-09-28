import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { kelvinToRgb } from "@/shared/lib/color";
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

describe("SolidColorPanel — Colour and White", () => {
  function renderWith(incoming: { r: number; g: number; b: number; brightness: number; kelvin?: number | null }) {
    vi.useFakeTimers();
    const onCommit = vi.fn<(draft: { r: number; g: number; b: number; brightness: number; kelvin?: number | null }) => void>();
    const view = render(<SolidColorPanel incoming={incoming} disabled={false} onCommit={onCommit} />);
    return { onCommit, view };
  }

  it("opens on White with its temperature when the running solid is a white", () => {
    renderWith({ r: 255, g: 206, b: 166, brightness: 1, kelvin: 4000 });
    expect(screen.getByTestId("solid-tone-white")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("solid-kelvin")).toHaveValue("4000");
  });

  // Rust resolves the colour from the temperature too; the RGB sent is what the swatch shows.
  it("White sends the temperature with the white it makes", () => {
    const { onCommit } = renderWith({ r: 10, g: 20, b: 30, brightness: 0.5 });
    fireEvent.click(screen.getByTestId("solid-tone-white"));
    vi.runAllTimers();
    expect(onCommit).toHaveBeenLastCalledWith({ ...kelvinToRgb(4000), brightness: 0.5, kelvin: 4000 });
    vi.useRealTimers();
  });

  it("Colour drops the temperature and keeps the white it showed", () => {
    const { onCommit } = renderWith({ r: 255, g: 177, b: 110, brightness: 1, kelvin: 3000 });
    fireEvent.click(screen.getByTestId("solid-tone-colour"));
    vi.runAllTimers();
    expect(onCommit).toHaveBeenLastCalledWith({ r: 255, g: 177, b: 110, brightness: 1 });
    vi.useRealTimers();
  });
});
