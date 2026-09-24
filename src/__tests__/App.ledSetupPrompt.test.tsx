// The first connect with no saved LED layout. It used to switch the window to
// LED Setup, so the user never saw the chip type and colour order on the page
// they connected from. It now leaves them there and says what comes next.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { CALIBRATION, bootDone, env, loadShellStateMock, publish, resetAppHarness } from "./support/appHarness";

// Every App.*.test.tsx registers the same mocks (./support/appHarness.tsx),
// except the entry flow: the real one is what is under test.
vi.mock("react-i18next", async () => (await import("./support/appHarness")).mockReactI18next);
vi.mock("@tauri-apps/api/core", async () => (await import("./support/appHarness")).mockTauriCore);
vi.mock("@tauri-apps/api/window", async () => (await import("./support/appHarness")).mockTauriWindow);
vi.mock("../features/tray/trayController", async () => (await import("./support/appHarness")).mockTrayController);
vi.mock("../features/tray/trayApi", async () => (await import("./support/appHarness")).mockTrayApi);
vi.mock("../features/updater/useAutoUpdater", async () => (await import("./support/appHarness")).mockAutoUpdater);
vi.mock("../features/shell/windowLifecycle", async () => (await import("./support/appHarness")).mockWindowLifecycle);
vi.mock("../features/device/useDeviceConnection", async () => (await import("./support/appHarness")).mockDeviceConnection);
vi.mock("../features/device/useWledSink", async () => (await import("./support/appHarness")).mockWledSink);
vi.mock("../features/mode/state/modeGuard", async () => (await import("./support/appHarness")).mockModeGuard);
vi.mock("../features/mode/modeApi", async () => (await import("./support/appHarness")).mockModeApi);
vi.mock("../features/mode/lightingRuntimeEventsApi", async () => (await import("./support/appHarness")).mockLightingRuntimeEvents);
vi.mock("../features/telemetry/runtimeHealthEventsApi", async () => (await import("./support/appHarness")).mockRuntimeHealthEvents);
vi.mock("../features/shell/StatusBar", async () => (await import("./support/appHarness")).mockStatusBar);
vi.mock("../features/settings/SettingsLayout", async () => (await import("./support/appHarness")).mockSettingsLayout);
vi.mock("../features/hue/hueHealthApi", async () => (await import("../features/hue/__tests__/fakeHueHealth")).fakeHueHealthApi);

import App from "../App";
import { LED_SETUP_PROMPTED_KEY } from "../features/calibration/state/useLedSetupPrompt";
import { __resetHueHealthStoreForTests } from "../features/hue/state/hueHealthStore";
import { resetHealth } from "../features/hue/__tests__/fakeHueHealth";

beforeEach(() => {
  vi.clearAllMocks();
  __resetHueHealthStoreForTests();
  resetHealth();
  resetAppHarness();
  sessionStorage.removeItem(LED_SETUP_PROMPTED_KEY);
  // A reload restores the last section; a cold launch always opens Lights.
  sessionStorage.setItem("lumasync_session", "1");
});

async function connectOnDevices(savedLayout: boolean) {
  env.isConnected = false;
  loadShellStateMock.mockResolvedValue({
    lastSection: "devices",
    uiMode: "full",
    hasCompletedOnboarding: true,
    ...(savedLayout ? { ledCalibration: CALIBRATION } : {}),
  });
  render(<App />);
  await bootDone();
  expect(screen.getByTestId("active-section")).toHaveTextContent("devices");

  env.isConnected = true;
  // Any shell render re-reads the (mocked) connection hook.
  publish({});
}

it("stays on Devices after the first connect and points at LED Setup instead", async () => {
  await connectOnDevices(false);

  expect(await screen.findByTestId("led-setup-next-notice")).toBeInTheDocument();
  expect(screen.getByTestId("active-section")).toHaveTextContent("devices");
});

it("says nothing when a layout is already saved", async () => {
  await connectOnDevices(true);

  await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("devices"));
  expect(screen.queryByTestId("led-setup-next-notice")).toBeNull();
});
