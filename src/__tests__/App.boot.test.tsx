// App's launch: the lighting restore it asks Rust for, and the onboarding
// banner that must not flash at a user already set up while boot is still
// reading the guards that would complete it.

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_COMMANDS } from "@/shared/contracts/device";
import { HUE_COMMANDS } from "@/shared/contracts/hue";

import {
  bootDone,
  choices,
  env,
  installInvokeDispatch,
  invokeMock,
  loadShellStateMock,
  nextApplyRuns,
  publish,
  resetAppHarness,
  saveShellStateMock,
} from "./support/appHarness";

// Every App.*.test.tsx registers the same mocks; see ./support/appHarness.tsx.
vi.mock("react-i18next", async () => (await import("./support/appHarness")).mockReactI18next);
vi.mock("@tauri-apps/api/core", async () => (await import("./support/appHarness")).mockTauriCore);
vi.mock("@tauri-apps/api/window", async () => (await import("./support/appHarness")).mockTauriWindow);
vi.mock("../features/tray/trayController", async () => (await import("./support/appHarness")).mockTrayController);
vi.mock("../features/tray/trayApi", async () => (await import("./support/appHarness")).mockTrayApi);
vi.mock("../features/updater/useAutoUpdater", async () => (await import("./support/appHarness")).mockAutoUpdater);
vi.mock("../features/shell/windowLifecycle", async () => (await import("./support/appHarness")).mockWindowLifecycle);
vi.mock("../features/device/useDeviceConnection", async () => (await import("./support/appHarness")).mockDeviceConnection);
vi.mock("../features/device/useWledSink", async () => (await import("./support/appHarness")).mockWledSink);
vi.mock("../features/calibration/state/entryFlow", async () => (await import("./support/appHarness")).mockEntryFlow);
vi.mock("../features/mode/state/modeGuard", async () => (await import("./support/appHarness")).mockModeGuard);
vi.mock("../features/mode/modeApi", async () => (await import("./support/appHarness")).mockModeApi);
vi.mock("../features/mode/lightingRuntimeEventsApi", async () => (await import("./support/appHarness")).mockLightingRuntimeEvents);
vi.mock("../features/shell/StatusBar", async () => (await import("./support/appHarness")).mockStatusBar);
vi.mock("../features/settings/SettingsLayout", async () => (await import("./support/appHarness")).mockSettingsLayout);

import App from "../App";
import { __resetHueReadCacheForTests } from "../features/hue/hueReadCache";

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level cache: without this a prior test's status leaks into the next one.
  __resetHueReadCacheForTests();
  resetAppHarness();
});

describe("App boot", () => {
  describe("the launch restore", () => {
    it("asks Rust once, and shows what it says runs", async () => {
      nextApplyRuns({
        mode: { kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 0.5 } },
        active: true,
        activeTargets: ["usb"],
      });

      render(<App />);

      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("solid"));
      expect(choices()).toEqual([{ origin: "boot" }]);
    });

    it("shows Off when Rust ran nothing, with the saved outputs still selected", async () => {
      nextApplyRuns({ selectedTargets: ["usb", "hue"] });

      render(<App />);

      await bootDone();
      await waitFor(() => expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue"));
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });

    it("says it waits for a bridge that still holds the last session, then drops the notice", async () => {
      render(<App />);
      await bootDone();

      publish({ bootHueRetry: "waiting" });
      await waitFor(() =>
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).toContain("hue-boot-retry"),
      );

      publish({ bootHueRetry: null });
      await waitFor(() =>
        // With nothing queued the slot is not mounted at all.
        expect(screen.queryByTestId("shell-notice-slot")?.getAttribute("data-queue") ?? "").not.toContain(
          "hue-boot-retry",
        ),
      );
    });
  });

  // An upgrader has no `hasCompletedOnboarding` on disk, and bootstrap clears the
  // flag before it has read the guards that would complete the flow — so the
  // banner mounted for as long as the slowest guard took, then vanished.
  describe("onboarding banner for a user who is already set up", () => {
    /**
     * Records every time onboarding enters the notice queue, including behind
     * "+N" where no card renders, and one removed before anyone looks.
     */
    function watchForBanner() {
      let seen = false;
      const queued = () =>
        Array.from(document.querySelectorAll("[data-queue]")).some((slot) =>
          (slot.getAttribute("data-queue") ?? "").split(" ").includes("onboarding"),
        );
      const observer = new MutationObserver(() => {
        if (queued()) seen = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue"] });
      return {
        seen: () => seen || queued(),
        stop: () => observer.disconnect(),
      };
    }

    function delay(command: string, ms: number) {
      const base = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation((name: string, ...rest: unknown[]) =>
        name === command
          ? new Promise((resolve) => setTimeout(() => resolve(base(name, ...rest)), ms))
          : base(name, ...rest),
      );
    }

    const completed = () =>
      expect(saveShellStateMock).toHaveBeenCalledWith({ hasCompletedOnboarding: true });

    it("never shows it while the serial status bootstrap awaits is slow", async () => {
      // Every guard is met by the describe-level state: a saved calibration, a
      // persisted mode and a connected strip.
      delay(DEVICE_COMMANDS.GET_CONNECTION_STATUS, 300);
      const banner = watchForBanner();

      render(<App />);

      await waitFor(completed, { timeout: 2_000 });
      expect(banner.seen()).toBe(false);
      banner.stop();
    });

    it("never shows it while the only reachable output is a bridge still being probed", async () => {
      env.isConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValue({
        lastSection: "general",
        ledCalibration: {
          templateId: "monitor-27-16-9",
          counts: { top: 10, right: 10, bottom: 10, left: 10 },
          bottomMissing: 0,
          cornerOwnership: "horizontal",
          visualPreset: "subtle",
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 40,
        },
        lightingMode: { kind: "off" },
        lastOutputTargets: ["hue"],
        lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
        hueAppKey: "app-user",
        hueClientKey: "AABBCCDD11223344",
        lastHueAreaId: "area-1",
      });
      // The last guard resolves well after bootstrap, in a tick of its own.
      delay(HUE_COMMANDS.VALIDATE_CREDENTIALS, 400);
      const banner = watchForBanner();

      render(<App />);

      await waitFor(completed, { timeout: 2_000 });
      expect(banner.seen()).toBe(false);
      banner.stop();
    });

    it("still greets a fresh install at step 1", async () => {
      env.isConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValue({ lastSection: "general" });

      render(<App />);

      // Behind "no reachable output", which outranks it in the queue.
      await waitFor(() => {
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")?.split(" ")).toEqual([
          "output-none",
          "onboarding",
        ]);
      });
      await act(async () => {
        screen.getByTestId("notice-toggle").click();
      });
      expect(screen.getByTestId("onboarding-notice")).toHaveTextContent("shell:notices.messages.onboarding.lights");
    });
  });
});
