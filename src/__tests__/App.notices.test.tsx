// Where the shell's notice slot sits: a row of its own above the layout, and
// inert under the update prompt.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { env, loadShellStateMock, resetAppHarness } from "./support/appHarness";

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

import App from "../App";
import { __resetHueReadCacheForTests } from "../features/hue/hueReadCache";

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level cache: without this a prior test's status leaks into the next one.
  __resetHueReadCacheForTests();
  resetAppHarness();
});

// No layout engine here, so only the structure is assertable, not the heights
// it decides — as a block column the banner clipped 162 px at 320×480.
// The toasts were z-50 like the modal and later in the DOM, so they drew
// over it, outside its focus trap.
it.each(["compact", "full"] as const)(
  "keeps the notices under the update prompt, inert and silent, in %s",
  async (uiMode) => {
    env.isConnected = false;
    loadShellStateMock.mockResolvedValue({ lastSection: "general", uiMode });
    env.updaterState = {
      status: "available",
      update: { version: "9.9.9", currentVersion: "1.0.0", body: null, date: null },
    };

    render(<App />);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).not.toBe("");
    });
    const slot = screen.getByTestId("shell-notice-slot");
    expect(slot).toHaveAttribute("inert");
    expect(dialog.contains(slot)).toBe(false);
    // Later in the document, so it paints above at any equal z-index.
    expect(slot.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("shell-notice-announcer")).toBeEmptyDOMElement();
  },
);

// Full used to float its notices bottom right, over the page; both modes now
// give the slot a row of its own above the layout.
it.each(["compact", "full"] as const)("gives the %s notice slot its own row instead of letting it push the layout out", async (uiMode) => {
  // A fresh install: no guard is ever met and nothing is reachable, so the
  // slot mounts and stays.
  env.isConnected = false;
  loadShellStateMock.mockResolvedValue({ lastSection: "lights", uiMode });

  render(<App />);

  await waitFor(() => {
    expect(screen.queryByTestId("shell-notice-slot")).not.toBeNull();
  });

  const noticeSlot = screen.getByTestId("shell-notice-slot");
  expect(noticeSlot).toHaveClass("lm-notice-slot");
  expect(noticeSlot).toHaveAttribute("data-variant", uiMode);

  const slot = noticeSlot.parentElement!;
  expect(slot.className).toContain("flex");
  expect(slot.className).toContain("flex-col");

  // The layout sits in a sibling box that may shrink; `min-h-0` is what lets
  // it, since a flex item's auto minimum would otherwise pin it to content.
  const layoutBox = screen.getByTestId("active-mode").closest("div")!.parentElement!;
  expect(layoutBox.parentElement).toBe(slot);
  expect(layoutBox.className).toContain("flex-1");
  expect(layoutBox.className).toContain("min-h-0");
});
