import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const { saveShellStoreMock } = vi.hoisted(() => ({
  saveShellStoreMock: vi.fn<(partial: unknown) => Promise<void>>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    save: (partial: unknown) => saveShellStoreMock(partial),
    load: () => loadShellStoreMock(),
    onSaved: () => () => {},
  },
}));

vi.mock("@/features/platform/platformApi", () => ({
  openLogDir: () => openLogDirMock(),
}));

import { __resetPreferencesForTests } from "@/features/persistence/preferences";
import { APP_VERSION } from "@/shared/constants/app";
import { defaultUpdateChannel } from "@/shared/contracts/shell";

import { __resetLaunchAtLoginForTests } from "../rows/GeneralRows";
import { SettingsPage } from "../SettingsPage";
import { UP_TO_DATE_RESULT_MS } from "../rows/UpdateRows";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "../settingsRegistry";

type Env = Parameters<typeof SettingsPage>[0];
const BASE: Env = { onCheckForUpdates: () => {}, isCheckingForUpdates: false, localOutputConnected: false };

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderPage(page: SettingsPageId, props: Partial<Env> = {}) {
  const view = render(<SettingsPage {...BASE} {...props} />);
  await act(async () => {
    screen.getByTestId(`settings-page-${page}`).click();
  });
  await settle();
  return view;
}

describe("SettingsPage", () => {
  beforeEach(() => {
    getStartupEnabledMock.mockReset().mockResolvedValue(false);
    setStartupMock.mockReset().mockImplementation((enabled) => Promise.resolve(enabled));
    loadShellStoreMock.mockReset().mockResolvedValue({});
    saveShellStoreMock.mockReset().mockResolvedValue(undefined);
    openLogDirMock.mockReset().mockResolvedValue(undefined);
    __resetPreferencesForTests();
    __resetLaunchAtLoginForTests();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("structure", () => {
    it("lists the pages in order and marks the open one, General first", async () => {
      render(<SettingsPage {...BASE} />);
      await settle();

      const items = SETTINGS_PAGE_IDS.map((id) => screen.getByTestId(`settings-page-${id}`));
      expect(items.map((item) => item.textContent)).toEqual([
        "settings:pages.general",
        "settings:pages.appearance",
        "settings:pages.updates",
        "settings:pages.help",
        "settings:pages.about",
      ]);
      expect(items[0]).toHaveAttribute("aria-current", "page");
      expect(items.slice(1).every((item) => !item.hasAttribute("aria-current"))).toBe(true);
      expect(screen.getByRole("navigation", { name: "settings:title" })).toBeInTheDocument();
    });

    it("opens on the page it was left on when the section comes back", async () => {
      const first = render(<SettingsPage {...BASE} />);
      await settle();
      fireEvent.click(screen.getByTestId("settings-page-about"));
      first.unmount();

      render(<SettingsPage {...BASE} />);
      await settle();

      expect(screen.getByTestId("settings-page-about")).toHaveAttribute("aria-current", "page");
    });

    it("names each page's region by its heading and shows only that page's rows", async () => {
      await renderPage("help");

      expect(screen.getByRole("region", { name: "settings:pages.help" })).toBeInTheDocument();
      expect(screen.getByTestId("settings-page-help")).toHaveAttribute("aria-current", "page");
      expect(screen.getByTestId("open-log-folder")).toBeInTheDocument();
      expect(screen.queryByTestId("launch-at-login-toggle")).not.toBeInTheDocument();
    });

    it("keeps an explanation behind the row's ⓘ, not on the screen", async () => {
      await renderPage("updates");
      expect(screen.queryByText("updater:betaChannelDescription")).not.toBeInTheDocument();

      await act(async () => {
        screen.getByRole("button", { name: "common:hintFor", expanded: false }).click();
      });

      expect(screen.getByRole("dialog")).toHaveTextContent("updater:betaChannelDescription");
    });
  });

  describe("launch at login", () => {
    // The old toggle read the OS state and inverted it, so a stale switch
    // turned autostart off when the user asked for on.
    it("asks for exactly the value the switch moved to", async () => {
      getStartupEnabledMock.mockResolvedValue(false);
      await renderPage("general");

      const toggle = screen.getByTestId("launch-at-login-toggle");
      await act(async () => {
        toggle.click();
      });

      expect(setStartupMock).toHaveBeenCalledWith(true);
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    it("shows what the OS reports after the change, not what was asked", async () => {
      setStartupMock.mockResolvedValue(false);
      await renderPage("general");

      const toggle = screen.getByTestId("launch-at-login-toggle");
      await act(async () => {
        toggle.click();
      });

      expect(toggle).toHaveAttribute("aria-checked", "false");
    });

    it("logs a failed change and says so on the row", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      setStartupMock.mockRejectedValue(new Error("launchd refused"));
      await renderPage("general");

      await act(async () => {
        screen.getByTestId("launch-at-login-toggle").click();
      });

      expect(screen.getByTestId("startup-error")).toHaveTextContent("settings:startupTray.writeError");
      expect(screen.getByTestId("startup-error")).toHaveAttribute("role", "alert");
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error));
    });

    it("draws no switch until the OS has answered, then opens on the answer", async () => {
      let answer: (on: boolean) => void = () => {};
      getStartupEnabledMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      await renderPage("general");
      expect(screen.queryByTestId("launch-at-login-toggle")).not.toBeInTheDocument();

      await act(async () => {
        answer(true);
      });

      expect(screen.getByTestId("launch-at-login-toggle")).toHaveAttribute("aria-checked", "true");
    });

    it("opens a revisit on the answer it already has, without waiting for the OS again", async () => {
      getStartupEnabledMock.mockResolvedValue(true);
      await renderPage("general");
      cleanup();

      getStartupEnabledMock.mockReturnValue(new Promise(() => {}));
      render(<SettingsPage {...BASE} />);

      expect(screen.getByTestId("launch-at-login-toggle")).toHaveAttribute("aria-checked", "true");
    });

    it("logs a failed read instead of swallowing it", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      getStartupEnabledMock.mockRejectedValue(new Error("no autostart plugin"));
      await renderPage("general");

      expect(screen.getByTestId("startup-error")).toHaveTextContent("settings:startupTray.readError");
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error));
    });
  });

  describe("appearance", () => {
    it("reduces motion by storing it, and follows the system when turned off", async () => {
      await renderPage("appearance");
      const toggle = screen.getByTestId("reduce-motion-toggle");
      expect(toggle).toHaveAttribute("aria-checked", "false");

      await act(async () => {
        toggle.click();
      });
      expect(saveShellStoreMock).toHaveBeenLastCalledWith({ motion: "reduce" });
      expect(toggle).toHaveAttribute("aria-checked", "true");

      await act(async () => {
        toggle.click();
      });
      expect(saveShellStoreMock).toHaveBeenLastCalledWith({ motion: "system" });
    });

    it("shows a stored choice", async () => {
      loadShellStoreMock.mockResolvedValue({ motion: "reduce", showNerdStats: true });
      await renderPage("appearance");

      expect(screen.getByTestId("reduce-motion-toggle")).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("nerd-stats-toggle")).toHaveAttribute("aria-checked", "true");
    });
  });

  describe("check for updates", () => {
    // UP_TO_DATE left the updater at `idle`, so a manual check said nothing.
    it("says the version is current, politely, after a check that found nothing", async () => {
      const now = new Date(2026, 8, 25, 14, 5).getTime();
      await renderPage("updates", { upToDateAt: now });

      const result = screen.getByTestId("update-check-result");
      expect(result).toHaveAttribute("aria-live", "polite");
      expect(result.textContent).toMatch(/^updater:upToDate\[time=.*05/);
    });

    it("lets the result go after a while, and hides it while a new check runs", async () => {
      vi.useFakeTimers();
      const { rerender } = await renderPage("updates", { upToDateAt: 1_000 });
      expect(screen.getByTestId("update-check-result").textContent).not.toBe("");

      rerender(<SettingsPage {...BASE} isCheckingForUpdates upToDateAt={1_000} />);
      expect(screen.getByTestId("update-check-result")).toBeEmptyDOMElement();

      rerender(<SettingsPage {...BASE} upToDateAt={1_000} />);
      act(() => {
        vi.advanceTimersByTime(UP_TO_DATE_RESULT_MS);
      });
      expect(screen.getByTestId("update-check-result")).toBeEmptyDOMElement();
    });

    it("shows the result in the button that asked for it, not under the row", async () => {
      await renderPage("updates", { upToDateAt: Date.now() });

      expect(screen.getByTestId("update-check")).toHaveAccessibleName("updater:upToDateShort");
    });

    it("names the button by its action while nothing has come back, and by the wait while checking", async () => {
      const { rerender } = await renderPage("updates");
      expect(screen.getByTestId("update-check")).toHaveAccessibleName("updater:checkAction");

      rerender(<SettingsPage {...BASE} isCheckingForUpdates />);
      expect(screen.getByTestId("update-check")).toHaveAccessibleName("updater:checking");
      expect(screen.getByTestId("update-check")).toBeDisabled();
    });

    it("says nothing when no check the user asked for has come back", async () => {
      await renderPage("updates");
      expect(screen.getByTestId("update-check-result")).toBeEmptyDOMElement();
    });
  });

  describe("update channel", () => {
    const betaSwitch = () => screen.getByRole("switch", { name: "updater:betaChannel" });

    it("defaults to the channel of the running build when nothing was chosen", async () => {
      await renderPage("updates");
      expect(betaSwitch()).toHaveAttribute("aria-checked", String(defaultUpdateChannel(APP_VERSION) === "beta"));
    });

    it("shows an explicit choice whatever the build", async () => {
      for (const stored of ["stable", "beta"] as const) {
        // A new session each round: the preferences hold what the first boot read said.
        __resetPreferencesForTests();
        loadShellStoreMock.mockResolvedValue({ updateChannel: stored });
        await renderPage("updates");
        expect(betaSwitch()).toHaveAttribute("aria-checked", String(stored === "beta"));
        cleanup();
      }
    });
  });

  describe("joining the beta", () => {
    beforeEach(() => {
      loadShellStoreMock.mockResolvedValue({ updateChannel: "stable" });
    });

    it("asks once more before switching, and switches only on yes", async () => {
      await renderPage("updates");
      const toggle = screen.getByTestId("beta-channel-toggle");

      await act(async () => {
        toggle.click();
      });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(saveShellStoreMock).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "updater:betaChannel" })).toHaveTextContent("updater:betaConfirm.text");
      expect(screen.getByTestId("beta-confirm-yes")).toHaveFocus();

      await act(async () => {
        screen.getByTestId("beta-confirm-yes").click();
      });
      expect(saveShellStoreMock).toHaveBeenCalledWith({ updateChannel: "beta" });
      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(screen.queryByRole("dialog", { name: "updater:betaChannel" })).not.toBeInTheDocument();
    });

    it("stays on stable when the question is dismissed with Escape, and gives focus back", async () => {
      await renderPage("updates");
      const toggle = screen.getByTestId("beta-channel-toggle");
      await act(async () => {
        toggle.click();
      });

      await act(async () => {
        fireEvent.keyDown(screen.getByTestId("beta-confirm-yes"), { key: "Escape" });
      });

      expect(screen.queryByRole("dialog", { name: "updater:betaChannel" })).not.toBeInTheDocument();
      expect(saveShellStoreMock).not.toHaveBeenCalled();
      expect(toggle).toHaveFocus();
    });

    it("closes the question when the switch is pressed again", async () => {
      await renderPage("updates");
      const toggle = screen.getByTestId("beta-channel-toggle");

      await act(async () => {
        toggle.click();
      });
      await act(async () => {
        toggle.click();
      });

      expect(screen.queryByRole("dialog", { name: "updater:betaChannel" })).not.toBeInTheDocument();
      expect(saveShellStoreMock).not.toHaveBeenCalled();
    });

    it("leaves the beta without asking: stable is the safe way", async () => {
      loadShellStoreMock.mockResolvedValue({ updateChannel: "beta" });
      await renderPage("updates");

      await act(async () => {
        screen.getByTestId("beta-channel-toggle").click();
      });

      expect(screen.queryByRole("dialog", { name: "updater:betaChannel" })).not.toBeInTheDocument();
      expect(saveShellStoreMock).toHaveBeenCalledWith({ updateChannel: "stable" });
    });
  });

  describe("help", () => {
    it("brings the setup guide back and says where it went", async () => {
      const restart = vi.fn(() => "shown" as const);
      await renderPage("help", { onRestartSetupGuide: restart });

      await act(async () => {
        screen.getByTestId("setup-guide-restart").click();
      });

      expect(restart).toHaveBeenCalledOnce();
      expect(screen.getByTestId("setup-guide-result")).toHaveTextContent("settings:help.guide.shown");
    });

    // A set-up user's restart completes again at once; a silent button reads as dead.
    it("says so when every step of the guide is already done", async () => {
      await renderPage("help", { onRestartSetupGuide: () => "alreadyDone" });

      await act(async () => {
        screen.getByTestId("setup-guide-restart").click();
      });

      expect(screen.getByTestId("setup-guide-result")).toHaveTextContent("settings:help.guide.alreadyDone");
    });

    it("has no guide row where there is no guide to bring back", async () => {
      await renderPage("help");
      expect(screen.queryByTestId("setup-guide-restart")).not.toBeInTheDocument();
    });

    it("opens the log folder, and reports a failure instead of swallowing it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await renderPage("help");

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
      await renderPage("help");

      const issue = screen.getByTestId("report-issue-link");
      const url = new URL(issue.getAttribute("href") ?? "");
      expect(`${url.origin}${url.pathname}`).toBe("https://github.com/voyvodka/LumaSync/issues/new");
      expect(url.searchParams.get("template")).toBe("bug_report.md");
      expect(url.searchParams.get("body")).toContain(`- App version: ${APP_VERSION}`);
      expect(issue).toHaveAttribute("target", "_blank");

      const discussions = screen.getByTestId("discussions-link");
      expect(discussions).toHaveAttribute("href", "https://github.com/voyvodka/LumaSync/discussions");
      expect(discussions).toHaveAttribute("target", "_blank");
    });
  });
});
