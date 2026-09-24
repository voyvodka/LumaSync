// Compact/full switches through the real App, TitleBar and Devices page, with the Hue
// channel map mounted against a paired, idle bridge. Only the Tauri boundary is
// faked: IPC, the window handle, and the store behind `windowLifecycle`.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS } from "@/shared/contracts/hue";
import { HUE_HEALTH_COMMANDS } from "@/shared/contracts/hueHealth";
import { idleHealth } from "../features/hue/__tests__/fakeHueHealth";
import { KEYBIND_ACTIONS, getKeybindDefinition, type ShellState } from "@/shared/contracts/shell";

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
  listenStartupToggle: () => Promise.resolve(() => {}),
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
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    devSetState: vi.fn(),
  }),
}));

let shellState: Partial<ShellState> = {};
const resizeToModeMock = vi.fn();

vi.mock("../features/shell/windowLifecycle", () => ({
  loadShellState: () => Promise.resolve(structuredClone(shellState)),
  saveShellState: (patch: Partial<ShellState>) => {
    shellState = { ...shellState, ...structuredClone(patch) };
    return Promise.resolve();
  },
  initWindowLifecycle: () => Promise.resolve(),
  onShellStateSaved: () => () => {},
  resizeToMode: (...args: unknown[]) => resizeToModeMock(...args),
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

const AREA_ID = "c8a76249-6d93-4408-aba4-ec8df20d0d28";
const BRIDGE = { id: "bridge-1", ip: "192.168.1.180", name: "Hue Bridge" };

function ok<C extends string>(code: C) {
  return { code, message: code, details: null };
}

function hueIpc(command: string): unknown {
  switch (command) {
    case HUE_COMMANDS.VALIDATE_CREDENTIALS:
      return { valid: true, status: ok("HUE_CREDENTIAL_VALID") };
    case HUE_COMMANDS.MIGRATE_CREDENTIALS:
      return { status: ok("HUE_CREDENTIAL_MIGRATION_OK"), backend: "keychain" };
    case HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS:
      return {
        status: ok("HUE_AREA_LIST_OK"),
        areas: [{ id: AREA_ID, name: "TV", roomName: null, channelCount: 2, activeStreamer: false }],
      };
    case HUE_COMMANDS.CHECK_STREAM_READINESS:
      return { status: ok("HUE_STREAM_READY"), readiness: { ready: true, reasons: [] } };
    case HUE_HEALTH_COMMANDS.GET_HUE_HEALTH:
    case HUE_HEALTH_COMMANDS.WATCH_HUE_HEALTH:
    case HUE_HEALTH_COMMANDS.RETRY_HUE_HEALTH:
      return idleHealth();
    case HUE_COMMANDS.GET_AREA_CHANNELS:
      return {
        status: ok("HUE_AREA_CHANNELS_OK"),
        channels: [
          { index: 0, channelId: 0, lightIds: ["l0"], positionX: 0.168, positionY: 1, positionZ: -0.524, lightCount: 1, autoRegion: "left" },
          { index: 1, channelId: 1, lightIds: ["l1"], positionX: -0.563, positionY: 1, positionZ: -0.641, lightCount: 1, autoRegion: "right" },
        ],
      };
    default:
      return undefined;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resizeToModeMock.mockResolvedValue(undefined);
  shellState = {
    uiMode: "full",
    lastSection: "devices",
    trayHintShown: true,
    hasCompletedOnboarding: true,
    lastHueBridge: BRIDGE,
    lastHueAreaId: AREA_ID,
    hueAppKey: "app-key",
    hueClientKey: "client-key",
    hueCredentialStatus: "valid",
    hueBridgeSyncedPositions: {
      [AREA_ID]: [
        { channelId: 0, positionX: 0.2, positionY: 0.8, positionZ: 0.5 },
        { channelId: 1, positionX: -0.5, positionY: 0.8, positionZ: -0.2 },
      ],
    },
  } as Partial<ShellState>;
  invokeMock.mockImplementation((command: string) => {
    const hue = hueIpc(command);
    if (hue !== undefined) return Promise.resolve(hue);
    if (command === "list_displays") return Promise.resolve([]);
    return Promise.resolve({ connected: false, status: ok("OK"), ports: [] });
  });
});

import App from "../App";

describe("UI mode toggle with the Hue channel map mounted", () => {
  it("switches full → compact", async () => {
    const user = userEvent.setup();
    render(<App />);

    // A first launch opens on Lights; the Devices page mounts every category,
    // hiding all but one, so the channel map is live without opening Hue.
    await user.click(await screen.findByTestId("section-tab-devices"));
    await screen.findByRole(
      "region",
      { name: "hue:channelMap.title", hidden: true },
      { timeout: 5000 },
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.GET_AREA_CHANNELS, expect.anything()),
    );
    // The idle read is trusted and recorded — the new path this test guards.
    await waitFor(() =>
      expect(shellState.hueBridgeSyncedPositions?.[AREA_ID]).toEqual([
        { channelId: 0, positionX: 0.168, positionY: 1, positionZ: -0.524 },
        { channelId: 1, positionX: -0.563, positionY: 1, positionZ: -0.641 },
      ]),
    );

    await user.click(screen.getByTestId("ui-mode-toggle"));

    await waitFor(() => expect(resizeToModeMock).toHaveBeenCalledWith("compact"), { timeout: 3000 });
    expect(await screen.findByTestId("compact-layout", {}, { timeout: 3000 })).toBeTruthy();
  });
});

// ⌘, from compact asked for full twice — once through the fade-owning switch and
// once by resizing directly for the section change — and ran two window resize
// animations against each other.
describe("open settings from compact", () => {
  it("resizes the window to full exactly once and lands on System", async () => {
    shellState = { ...shellState, uiMode: "compact", lastSection: "lights" };
    render(<App />);
    expect(await screen.findByTestId("compact-layout", {}, { timeout: 3000 })).toBeTruthy();

    const { code, modifier } = getKeybindDefinition(KEYBIND_ACTIONS.OPEN_SETTINGS);
    fireEvent.keyDown(document, {
      code,
      metaKey: modifier === "meta",
      ctrlKey: modifier === "ctrl",
      altKey: modifier === "alt",
    });

    const systemTab = await screen.findByTestId("section-tab-system", {}, { timeout: 3000 });
    await waitFor(() => expect(systemTab).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(shellState.lastSection).toBe("system"));
    // Outlast the fade-out's safety timeout, after which a second resize would
    // have been issued.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(resizeToModeMock).toHaveBeenCalledTimes(1);
    expect(resizeToModeMock).toHaveBeenCalledWith("full");
  });
});
