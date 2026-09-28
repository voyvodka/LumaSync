import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_COLOR_CORRECTION, type ColorCorrectionConfig } from "@/shared/contracts/device";
import type { ShellState } from "@/shared/contracts/shell";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "kelvin" in options ? `${key}:${String(options.kelvin)}` : key,
  }),
}));

const stored: { state: Partial<ShellState> } = { state: {} };
const update = vi.fn(async (fn: (s: ShellState) => ShellState) => {
  stored.state = fn(stored.state as ShellState);
  return stored.state;
});
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: async () => stored.state,
    update: (fn: (s: ShellState) => ShellState) => update(fn),
    onSaved: () => () => undefined,
  },
}));

import { StripColorRow } from "../StripColorRow";

const warm: ColorCorrectionConfig = { ...DEFAULT_COLOR_CORRECTION, kelvin: 5200 };

describe("StripColorRow", () => {
  beforeEach(() => {
    stored.state = {};
    update.mockClear();
  });

  // Nothing is shown before the store answers, so no default slides to the real value.
  it("opens on the stored correction", async () => {
    stored.state = { colorCorrection: warm };
    render(<StripColorRow />);
    expect(screen.getByTestId("strip-color-value")).toHaveTextContent("");
    await waitFor(() =>
      expect(screen.getByTestId("strip-color-value")).toHaveTextContent("device:strip.color.summary:5200"),
    );
  });

  it("reads Default when nothing was changed", async () => {
    render(<StripColorRow />);
    await waitFor(() => expect(screen.getByTestId("strip-color-value")).toHaveTextContent("device:strip.color.default"));
  });

  it("saves an edit after the drag settles, and can put it back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stored.state = { colorCorrection: warm };
    render(<StripColorRow />);
    await waitFor(() => expect(screen.getByTestId("strip-color-edit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("strip-color-edit"));
    const saturation = screen.getByTestId("strip-color-saturation");
    fireEvent.change(saturation, { target: { value: "1.5" } });
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(stored.state.colorCorrection?.saturation).toBe(1.5);

    fireEvent.click(screen.getByTestId("strip-color-reset"));
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(stored.state.colorCorrection).toEqual(DEFAULT_COLOR_CORRECTION);
    expect(screen.getByTestId("strip-color-reset")).toBeDisabled();
    vi.useRealTimers();
  });
});
