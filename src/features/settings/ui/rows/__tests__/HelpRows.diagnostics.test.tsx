import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SettingsEnv } from "../../settingsEnv";
import { DiagnosticsRow } from "../HelpRows";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const ENV: SettingsEnv = { onCheckForUpdates: () => {}, isCheckingForUpdates: false, localOutputConnected: false };

describe("DiagnosticsRow", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("copies what the shell reads at the press, says so, then reads as the action again", async () => {
    vi.useFakeTimers();
    let state = "before";
    render(<DiagnosticsRow {...ENV} readDiagnostics={() => state} />);
    state = "at the press";

    await act(async () => {
      screen.getByTestId("copy-diagnostics").click();
    });

    expect(writeText).toHaveBeenCalledWith("at the press");
    expect(screen.getByRole("status")).toHaveTextContent("settings:help.diagnostics.copied");

    act(() => {
      vi.advanceTimersByTime(1_800);
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("logs a copy the system refused and claims nothing", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<DiagnosticsRow {...ENV} readDiagnostics={() => "text"} />);

    await act(async () => {
      screen.getByTestId("copy-diagnostics").click();
    });

    expect(error).toHaveBeenCalledWith("[LumaSync] copying the diagnostics failed:", expect.any(Error));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("has no row where there is no shell to read", () => {
    render(<DiagnosticsRow {...ENV} />);
    expect(screen.queryByTestId("copy-diagnostics")).toBeNull();
  });
});
