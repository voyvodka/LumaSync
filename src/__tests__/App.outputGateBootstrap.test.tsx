// Before boot has read the saved pairing, `hueStartConfig` is null, so a paired
// bridge looked unpaired and "No reachable output" flashed on launch. Driven
// through the real App with boot held open at its serial status check — after
// the UI mode is applied, before the pairing is projected.

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_COMMANDS } from "@/shared/contracts/device";
import { HUE_HEALTH_COMMANDS } from "@/shared/contracts/hueHealth";
import { idleHealth } from "../features/hue/__tests__/fakeHueHealth";
import type { ShellState, UIMode } from "@/shared/contracts/shell";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

vi.mock("../features/tray/trayController", () => ({
  listenTrayShowLedPreview: () => Promise.resolve(() => {}),
}));

vi.mock("../features/tray/trayApi", () => ({
  updateTrayLabels: () => Promise.resolve(),
}));

vi.mock("../features/updater/useAutoUpdater", () => ({
  useAutoUpdater: () => ({
    state: { status: "idle" },
    channel: "stable",
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    checkForUpdatesInBackground: vi.fn().mockResolvedValue(undefined),
    checkFailedNotice: null,
    upToDateAt: null,
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    devSetState: vi.fn(),
  }),
}));

let shellState: Partial<ShellState> = {};

vi.mock("../features/shell/windowLifecycle", () => ({
  loadShellState: () => Promise.resolve(structuredClone(shellState)),
  saveShellState: (patch: Partial<ShellState>) => {
    shellState = { ...shellState, ...structuredClone(patch) };
    return Promise.resolve();
  },
  initWindowLifecycle: () => Promise.resolve(),
  onShellStateSaved: () => () => {},
  resizeToMode: () => Promise.resolve(),
}));

vi.mock("../features/device/useDeviceConnection", () => ({
  useDeviceConnection: () => ({
    isConnected: false,
    connectedPort: null,
    ports: [],
  }),
}));

vi.mock("../features/device/useWledSink", () => ({
  useWledSinkRestore: () => undefined,
  useActiveWledSink: () => ({
    activeWledIp: null,
    savedSink: null,
    restoreOutcome: { kind: "idle" },
    ready: true,
    markConnected: async () => undefined,
  }),
}));

vi.mock("../features/shell/StatusBar", () => ({
  StatusBar: () => null,
  statusBarHeightPx: () => 24,
  STATUS_BAR_HEIGHT_FULL_PX: 24,
  STATUS_BAR_HEIGHT_COMPACT_PX: 22,
}));

const OFFLINE_TITLE = "shell:notices.messages.outputNone";
const BRIDGE = { id: "bridge-1", ip: "192.168.1.180", name: "Hue Bridge" };

function ok<C extends string>(code: C) {
  return { code, message: code, details: null };
}

let releaseSerialStatus: () => void = () => {};
let offlineBannerSeen = false;
let observer: MutationObserver | null = null;

// Records a banner that mounted at any point, including one that unmounted
// again before an assertion could look for it — the flash this file guards.
function watchForOfflineBanner() {
  offlineBannerSeen = false;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.textContent?.includes(OFFLINE_TITLE)) offlineBannerSeen = true;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function pairedState(uiMode: UIMode): Partial<ShellState> {
  return {
    uiMode,
    trayHintShown: true,
    hasCompletedOnboarding: true,
    lastHueBridge: BRIDGE,
    lastHueAreaId: "area-1",
    hueAppKey: "app-key",
    hueClientKey: "client-key",
    hueCredentialStatus: "valid",
  } as Partial<ShellState>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  const serialStatus = new Promise<void>((resolve) => {
    releaseSerialStatus = resolve;
  });
  invokeMock.mockImplementation(async (command: string) => {
    if (command === DEVICE_COMMANDS.GET_CONNECTION_STATUS) {
      await serialStatus;
      return { connected: false, status: ok("OK"), ports: [] };
    }
    // The health monitor's answer: a paired bridge whose probe found it.
    if (command === HUE_HEALTH_COMMANDS.WATCH_HUE_HEALTH) return idleHealth();
    if (command === "list_displays") return [];
    return { connected: false, status: ok("OK"), ports: [] };
  });
});

afterEach(() => {
  observer?.disconnect();
  observer = null;
});

import App from "../App";

async function bootHeldAtSerialStatus(uiMode: UIMode) {
  watchForOfflineBanner();
  render(<App />);
  await screen.findByTestId(uiMode === "compact" ? "compact-layout" : "full-layout");
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(DEVICE_COMMANDS.GET_CONNECTION_STATUS),
  );
}

describe("output gate during shell boot", () => {
  it.each<UIMode>(["compact", "full"])(
    "never shows the no-output banner to a paired-bridge user while boot runs (%s)",
    async (uiMode) => {
      shellState = pairedState(uiMode);
      await bootHeldAtSerialStatus(uiMode);

      expect(screen.getByTestId("output-checking")).toBeInTheDocument();
      expect(screen.queryByText(OFFLINE_TITLE)).not.toBeInTheDocument();

      await act(async () => {
        releaseSerialStatus();
      });
      // Settles on a usable bridge once the monitor's probe verdict arrives.
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith(HUE_HEALTH_COMMANDS.WATCH_HUE_HEALTH, expect.anything()),
      );
      await waitFor(() => expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument());
      expect(screen.queryByText(OFFLINE_TITLE)).not.toBeInTheDocument();
      expect(offlineBannerSeen).toBe(false);
    },
  );

  it("still tells an install with no output that there is none once boot has settled", async () => {
    shellState = { trayHintShown: true, hasCompletedOnboarding: true };
    await bootHeldAtSerialStatus("compact");

    expect(screen.queryByText(OFFLINE_TITLE)).not.toBeInTheDocument();

    await act(async () => {
      releaseSerialStatus();
    });
    expect(await screen.findByText(OFFLINE_TITLE)).toBeInTheDocument();
    expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument();
  });

  // A fresh install opened on the red error with the welcome behind "+1".
  it("greets a fresh install with the guide's first step instead of the error", async () => {
    shellState = { trayHintShown: true };
    await bootHeldAtSerialStatus("compact");

    await act(async () => {
      releaseSerialStatus();
    });
    expect(await screen.findByText("shell:notices.messages.onboarding.devices")).toBeInTheDocument();
    expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).toBe("onboarding");
    expect(offlineBannerSeen).toBe(false);
  });
});
