import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getStartupEnabledMock, setStartupMock, loadShellStoreMock, openLogDirMock } = vi.hoisted(() => ({
  getStartupEnabledMock: vi.fn<() => Promise<boolean>>(),
  setStartupMock: vi.fn<(enabled: boolean) => Promise<boolean>>(),
  loadShellStoreMock: vi.fn<() => Promise<Record<string, unknown>>>(),
  openLogDirMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "time" in opts ? `${key}[time=${String(opts.time)}]` : key,
  }),
}));

vi.mock("@/features/tray/trayController", () => ({
  getStartupEnabled: () => getStartupEnabledMock(),
  setStartup: (enabled: boolean) => setStartupMock(enabled),
}));

vi.mock("@/features/i18n/i18n", () => ({
  I18N_SUPPORTED_LANGUAGES: ["en", "tr"],
  I18N_LANGUAGE_NAMES: { en: "English", tr: "Türkçe" },
  changeLanguage: vi.fn<(lang: string) => Promise<void>>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    save: vi.fn<(partial: unknown) => Promise<void>>().mockResolvedValue(undefined),
    load: () => loadShellStoreMock(),
    onSaved: () => () => {},
  },
}));

vi.mock("@/features/platform/platformApi", () => ({
  openLogDir: () => openLogDirMock(),
}));

import { __resetShowNerdStatsForTests } from "@/features/telemetry/nerdStatsSetting";
import { APP_VERSION } from "@/shared/constants/app";
import { defaultUpdateChannel } from "@/shared/contracts/shell";

import { SystemSection, UP_TO_DATE_RESULT_MS } from "../SystemSection";

function renderSection(props: Partial<Parameters<typeof SystemSection>[0]> = {}) {
  return render(
    <SystemSection
      onCheckForUpdates={() => {}}
      isCheckingForUpdates={false}
      localOutputConnected={false}
      {...props}
    />,
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("SystemSection", () => {
  beforeEach(() => {
    getStartupEnabledMock.mockReset().mockResolvedValue(false);
    setStartupMock.mockReset().mockImplementation((enabled) => Promise.resolve(enabled));
    loadShellStoreMock.mockReset().mockResolvedValue({});
    openLogDirMock.mockReset().mockResolvedValue(undefined);
    __resetShowNerdStatsForTests();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("launch at login", () => {
    // The old toggle read the OS state and inverted it, so a stale switch
    // turned autostart off when the user asked for on.
    it("asks for exactly the value the switch moved to", async () => {
      getStartupEnabledMock.mockResolvedValue(false);
      renderSection();
      await settle();

      const toggle = screen.getByTestId("launch-at-login-toggle");
      await act(async () => {
        toggle.click();
      });

      expect(setStartupMock).toHaveBeenCalledWith(true);
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    it("shows what the OS reports after the change, not what was asked", async () => {
      setStartupMock.mockResolvedValue(false);
      renderSection();
      await settle();

      const toggle = screen.getByTestId("launch-at-login-toggle");
      await act(async () => {
        toggle.click();
      });

      expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("logs a failed change and says so on the row", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      setStartupMock.mockRejectedValue(new Error("launchd refused"));
      renderSection();
      await settle();

      await act(async () => {
        screen.getByTestId("launch-at-login-toggle").click();
      });

      expect(screen.getByTestId("startup-error")).toHaveTextContent("settings:startupTray.writeError");
      expect(screen.getByTestId("startup-error")).toHaveAttribute("role", "alert");
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error));
    });

    it("logs a failed read instead of swallowing it", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      getStartupEnabledMock.mockRejectedValue(new Error("no autostart plugin"));
      renderSection();
      await settle();

      expect(screen.getByTestId("startup-error")).toHaveTextContent("settings:startupTray.readError");
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error));
    });
  });

  describe("check for updates", () => {
    // UP_TO_DATE left the updater at `idle`, so a manual check said nothing.
    it("says the version is current, politely, after a check that found nothing", async () => {
      const now = new Date(2026, 8, 25, 14, 5).getTime();
      renderSection({ upToDateAt: now });
      await settle();

      const result = screen.getByTestId("update-check-result");
      expect(result).toHaveAttribute("aria-live", "polite");
      expect(result.textContent).toMatch(/^updater:upToDate\[time=.*05/);
    });

    it("lets the result go after a while, and hides it while a new check runs", async () => {
      vi.useFakeTimers();
      const { rerender } = renderSection({ upToDateAt: 1_000 });
      await settle();
      expect(screen.getByTestId("update-check-result").textContent).not.toBe("");

      rerender(
        <SystemSection onCheckForUpdates={() => {}} isCheckingForUpdates localOutputConnected={false} upToDateAt={1_000} />,
      );
      expect(screen.getByTestId("update-check-result")).toBeEmptyDOMElement();

      rerender(
        <SystemSection onCheckForUpdates={() => {}} isCheckingForUpdates={false} localOutputConnected={false} upToDateAt={1_000} />,
      );
      act(() => {
        vi.advanceTimersByTime(UP_TO_DATE_RESULT_MS);
      });
      expect(screen.getByTestId("update-check-result")).toBeEmptyDOMElement();
    });

    it("says nothing when no check the user asked for has come back", async () => {
      renderSection();
      await settle();
      expect(screen.getByTestId("update-check-result")).toBeEmptyDOMElement();
    });
  });

  describe("structure", () => {
    it("titles every group with a heading that names its region, About last", async () => {
      renderSection();
      await settle();

      const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(headings).toEqual([
        "settings:groups.startup.title",
        "settings:groups.language.title",
        "settings:groups.updates.title",
        "telemetry:title",
        "settings:groups.help.title",
        "settings:groups.about.title",
      ]);
      expect(screen.getByRole("region", { name: "settings:groups.about.title" })).toBeInTheDocument();
    });

    it("describes each switch by its row's description", async () => {
      renderSection();
      await settle();

      expect(screen.getByRole("switch", { name: "settings:startupTray.launchAtLogin" })).toHaveAccessibleDescription(
        "settings:startupTray.launchAtLoginDescription",
      );
      expect(screen.getByRole("switch", { name: "settings:nerdStats.label" })).toHaveAccessibleDescription(
        "settings:nerdStats.description",
      );
    });

    it("describes the language picker by its row", async () => {
      renderSection();
      await settle();
      await waitFor(() =>
        expect(screen.getByRole("combobox")).toHaveAccessibleDescription("settings:language.description"),
      );
    });
  });

  describe("update channel", () => {
    const betaSwitch = () => screen.getByRole("switch", { name: "updater:betaChannel" });

    it("defaults to the channel of the running build when nothing was chosen", async () => {
      renderSection();
      await settle();
      expect(betaSwitch()).toHaveAttribute("aria-checked", String(defaultUpdateChannel(APP_VERSION) === "beta"));
    });

    it("shows an explicit choice whatever the build", async () => {
      for (const stored of ["stable", "beta"] as const) {
        loadShellStoreMock.mockResolvedValue({ updateChannel: stored });
        renderSection();
        await settle();
        expect(betaSwitch()).toHaveAttribute("aria-checked", String(stored === "beta"));
        cleanup();
      }
    });
  });

  describe("help", () => {
    it("brings the setup guide back and says where it went", async () => {
      const restart = vi.fn(() => "shown" as const);
      renderSection({ onRestartSetupGuide: restart });
      await settle();

      await act(async () => {
        screen.getByTestId("setup-guide-restart").click();
      });

      expect(restart).toHaveBeenCalledOnce();
      expect(screen.getByTestId("setup-guide-result")).toHaveTextContent("settings:help.guide.shown");
    });

    // A set-up user's restart completes again at once; a silent button reads as dead.
    it("says so when every step of the guide is already done", async () => {
      renderSection({ onRestartSetupGuide: () => "alreadyDone" });
      await settle();

      await act(async () => {
        screen.getByTestId("setup-guide-restart").click();
      });

      expect(screen.getByTestId("setup-guide-result")).toHaveTextContent("settings:help.guide.alreadyDone");
    });

    it("has no guide row where there is no guide to bring back", async () => {
      renderSection();
      await settle();
      expect(screen.queryByTestId("setup-guide-restart")).not.toBeInTheDocument();
    });

    it("opens the log folder, and reports a failure instead of swallowing it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      renderSection();
      await settle();

      await act(async () => {
        screen.getByTestId("open-log-folder").click();
      });
      expect(openLogDirMock).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("log-folder-error")).not.toBeInTheDocument();

      openLogDirMock.mockRejectedValueOnce(new Error("no file manager"));
      await act(async () => {
        screen.getByTestId("open-log-folder").click();
      });
      expect(screen.getByRole("alert")).toHaveTextContent("settings:help.logs.error");
      expect(error).toHaveBeenCalledWith("[LumaSync] opening the log folder failed:", expect.any(Error));
    });

    // Nothing is sent by the app: both are links the browser opens, and the
    // issue form only arrives pre-filled.
    it("links to a pre-filled issue form and to Discussions, in the browser", async () => {
      renderSection();
      await settle();

      const issue = screen.getByTestId("report-issue-link");
      const url = new URL(issue.getAttribute("href") ?? "");
      expect(`${url.origin}${url.pathname}`).toBe("https://github.com/voyvodka/LumaSync/issues/new");
      expect(url.searchParams.get("template")).toBe("bug_report.md");
      expect(url.searchParams.get("body")).toContain(`- App version: ${APP_VERSION}`);
      expect(issue).toHaveAttribute("target", "_blank");
      expect(issue).toHaveAccessibleDescription("settings:help.issue.description");

      const discussions = screen.getByTestId("discussions-link");
      expect(discussions).toHaveAttribute("href", "https://github.com/voyvodka/LumaSync/discussions");
      expect(discussions).toHaveAttribute("target", "_blank");
    });
  });
});
