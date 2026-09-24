// App's side of the updater: the startup check is a background check, a failed
// one is a notice rather than the modal, and a download's progress reaches the
// modal without re-rendering the shell.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import {
  checkForUpdatesInBackgroundMock,
  checkForUpdatesMock,
  env,
  loadShellStateMock,
  resetAppHarness,
  setUpdaterState,
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
vi.mock("../features/telemetry/runtimeHealthEventsApi", async () => (await import("./support/appHarness")).mockRuntimeHealthEvents);
vi.mock("../features/shell/StatusBar", async () => (await import("./support/appHarness")).mockStatusBar);
vi.mock("../features/settings/SettingsLayout", async () => (await import("./support/appHarness")).mockSettingsLayout);
vi.mock("../features/hue/hueHealthApi", async () => (await import("../features/hue/__tests__/fakeHueHealth")).fakeHueHealthApi);

import App from "../App";
import { __resetHueHealthStoreForTests } from "../features/hue/state/hueHealthStore";
import { resetHealth } from "../features/hue/__tests__/fakeHueHealth";

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level store: without this a prior test's snapshot leaks into the next one.
  __resetHueHealthStoreForTests();
  resetHealth();
  resetAppHarness();
});

// A startup check that failed on a broken build used to open the blocking
// modal as "installation could not be completed".
it("runs the startup update check as a background check, never as a user check", async () => {
  loadShellStateMock.mockResolvedValue({ lastSection: "lights", uiMode: "compact" });

  render(<App />);

  await waitFor(() => {
    expect(checkForUpdatesInBackgroundMock).toHaveBeenCalledOnce();
  });
  expect(checkForUpdatesMock).not.toHaveBeenCalled();
});

it("offers a failed background check as a notice whose retry is a user check", async () => {
  // Off Lights and past onboarding, so nothing outranks the lowest-tier notice.
  loadShellStateMock.mockResolvedValue({ lastSection: "system", uiMode: "full", hasCompletedOnboarding: true });
  env.checkFailedNotice = { message: "check_for_update not allowed" };

  render(<App />);

  await screen.findByTestId("update-check-retry");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(checkForUpdatesMock).not.toHaveBeenCalled();

  // Re-queried: the slot re-renders as boot settles, so an early handle can be detached.
  await waitFor(() => {
    screen.getByTestId("update-check-retry").click();
    expect(checkForUpdatesMock).toHaveBeenCalledOnce();
  });
});

// The updater state used to live in App, so every progress event re-rendered
// the shell and, through its props, the whole page under the modal.
it("draws download progress in the modal without re-rendering the shell", async () => {
  loadShellStateMock.mockResolvedValue({ lastSection: "lights", uiMode: "full", hasCompletedOnboarding: true });
  const update = { version: "9.9.9", currentVersion: "1.0.0", body: null, date: null };
  const downloading = (progress: number) => ({
    status: "downloading",
    update,
    progress,
    downloadedBytes: progress * 1_000,
    totalBytes: 100_000,
    bytesPerSecond: 1_000,
    etaSeconds: 100 - progress,
  });
  env.updaterState = downloading(0);

  render(<App />);

  await screen.findByRole("dialog");
  await waitFor(() => expect(checkForUpdatesInBackgroundMock).toHaveBeenCalled());
  // Let boot's own renders settle before counting.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const appBefore = env.statusBarRenders;
  const layoutBefore = env.layoutRenders;
  const probeBefore = env.layoutProbeRenders;

  for (const progress of [10, 20, 30, 40]) setUpdaterState(downloading(progress));

  await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40"));
  expect(env.statusBarRenders).toBe(appBefore);
  expect(env.layoutRenders).toBe(layoutBefore);
  expect(env.layoutProbeRenders).toBe(probeBefore);
});
