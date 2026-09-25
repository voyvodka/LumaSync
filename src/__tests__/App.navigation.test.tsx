// App's navigation: which section the sections see, the compact → full switch a
// deep link makes, and what is persisted. The navigation store is what the
// sections read, so these go through it rather than through layout props.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALIBRATION,
  PAIRED,
  bootDone,
  env,
  loadShellStateMock,
  nextApplyRuns,
  resetAppHarness,
  resizeToModeMock,
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

describe("App navigation", () => {
  it("routes a calibration refusal to LED Setup", async () => {
    render(<App />);
    await bootDone();
    nextApplyRuns({}, "OUTPUTS_CALIBRATION_REQUIRED");

    await act(async () => {
      screen.getByText("set-ambilight").click();
    });

    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup"));
  });

  it("opens the saved section at boot and persists a tab change", async () => {
    const user = userEvent.setup();
    loadShellStateMock.mockResolvedValue({ lastSection: "system", uiMode: "full", ledCalibration: CALIBRATION });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("system"));
    expect(screen.getByTestId("ui-mode")).toHaveTextContent("full");

    await user.click(screen.getByTestId("section-tab-devices"));

    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("devices"));
    await waitFor(() => expect(saveShellStateMock).toHaveBeenCalledWith({ lastSection: "devices" }));
    // Already full: a tab change never resizes the window.
    expect(resizeToModeMock).not.toHaveBeenCalled();
    // Only a notice names a Devices category.
    expect(screen.getByTestId("device-category")).toHaveTextContent("");
  });

  it("takes a notice's Devices link from compact to full, on the category it names", async () => {
    loadShellStateMock.mockResolvedValue({
      lastSection: "lights",
      uiMode: "compact",
      hasCompletedOnboarding: true,
      ledCalibration: CALIBRATION,
      ...PAIRED,
      lastOutputTargets: ["usb", "hue"],
    });
    nextApplyRuns({
      mode: { kind: "ambilight", targets: ["usb"] },
      active: true,
      activeTargets: ["usb"],
      selectedTargets: ["usb"],
      hueHeldOutReason: "unreachable",
    });

    render(<App />);

    const link = await screen.findByRole("button", { name: /shell:notices\.actions\.devices/ });
    expect(screen.getByTestId("ui-mode")).toHaveTextContent("compact");

    await act(async () => {
      link.click();
    });

    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("devices"));
    expect(screen.getByTestId("device-category")).toHaveTextContent("hue");
    await waitFor(() => expect(screen.getByTestId("ui-mode")).toHaveTextContent("full"));
    expect(resizeToModeMock).toHaveBeenCalledTimes(1);
    expect(resizeToModeMock).toHaveBeenCalledWith("full");
    await waitFor(() => expect(saveShellStateMock).toHaveBeenCalledWith({ lastSection: "devices" }));
  });

  // LED Setup's draft used to vanish on a tab click or the compact toggle: the
  // page unmounted and only its own Cancel ever asked.
  it("asks the open screen's leave guard before a tab change or the compact switch", async () => {
    const user = userEvent.setup();
    loadShellStateMock.mockResolvedValue({ lastSection: "led-setup", uiMode: "full", ledCalibration: CALIBRATION });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup"));

    await user.click(screen.getByText("hold-leave"));
    await user.click(screen.getByTestId("section-tab-devices"));
    expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup");

    await user.click(screen.getByTestId("ui-mode-toggle"));
    // Longer than the fade-out, after which an unguarded switch would resize.
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(screen.getByTestId("ui-mode")).toHaveTextContent("full");
    expect(resizeToModeMock).not.toHaveBeenCalled();

    // The user agreed to leave: the last move asked for goes ahead.
    await act(async () => env.heldLeave?.());
    await waitFor(() => expect(screen.getByTestId("ui-mode")).toHaveTextContent("compact"));
  });

  it("does not ask when the tab is the one already open", async () => {
    const user = userEvent.setup();
    loadShellStateMock.mockResolvedValue({ lastSection: "led-setup", uiMode: "full", ledCalibration: CALIBRATION });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup"));

    await user.click(screen.getByText("hold-leave"));
    await user.click(screen.getByTestId("section-tab-led-setup"));

    expect(env.heldLeave).toBeNull();
  });

  it("holds the settings shortcut behind the leave guard too", async () => {
    const user = userEvent.setup();
    loadShellStateMock.mockResolvedValue({ lastSection: "led-setup", uiMode: "full", ledCalibration: CALIBRATION });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup"));

    await user.click(screen.getByText("hold-leave"));
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Comma", key: ",", ...modifier }),
        );
      });
    }

    expect(env.heldLeave).not.toBeNull();
    expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup");
    await act(async () => env.heldLeave?.());
    await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("system"));
  });
});

