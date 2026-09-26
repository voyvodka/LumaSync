import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { APP_VERSION } from "@/shared/constants/app";
import { AboutCard } from "../AboutCard";

describe("AboutCard", () => {
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

  it("copies the version with the OS for a bug report, says so, then reads as the version again", async () => {
    vi.useFakeTimers();
    render(<AboutCard />);
    const version = screen.getByTestId("about-version");

    await act(async () => {
      version.click();
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^LumaSync ${APP_VERSION.replace(/\./g, "\\.")}`)));
    expect(version).toHaveAccessibleName("settings:about.copied");
    expect(screen.getByRole("status")).toHaveTextContent("settings:about.copied");

    act(() => {
      vi.advanceTimersByTime(1_800);
    });
    expect(version).toHaveAccessibleName(`settings:about.copyVersion v${APP_VERSION}`);
  });

  it("logs a copy the system refused and claims nothing", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AboutCard />);

    await act(async () => {
      screen.getByTestId("about-version").click();
    });

    expect(error).toHaveBeenCalledWith("[LumaSync] copying the version failed:", expect.any(Error));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("links the site, the source, this version's notes and the licence, in the browser", () => {
    render(<AboutCard />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual([
      "https://lumasync.app",
      "https://github.com/voyvodka/LumaSync",
      `https://github.com/voyvodka/LumaSync/releases/tag/v${APP_VERSION}`,
      "https://github.com/voyvodka/LumaSync/blob/main/LICENSE",
    ]);
    for (const link of screen.getAllByRole("link")) expect(link).toHaveAttribute("target", "_blank");
  });
});
