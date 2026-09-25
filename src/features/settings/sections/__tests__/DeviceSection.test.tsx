import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import { DeviceSection } from "../DeviceSection";
import type * as calibrationApiModule from "@/features/calibration/calibrationApi";
import type * as wledApiModule from "@/features/device/wledApi";

const stopHueMock = vi.fn();
const stopHueOutputMock = vi.fn(async () => {});
const useHueOnboardingMock = vi.fn();
// Mutable so individual tests can override port list without re-declaring the mock.
const useDeviceConnectionMock = vi.fn();
let activeWledIpMock: string | null = null;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/mode/modeApi", () => ({
  stopHue: (...args: Parameters<typeof stopHueMock>) => stopHueMock(...args),
}));

vi.mock("@/features/device/useDeviceConnection", () => ({
  useDeviceConnection: () => useDeviceConnectionMock(),
}));

// Stubbed rather than left real: `useActiveWledSink` reads shell state through
// the same mocked `shellStore.load`, so a live one races the scenario's own
// `mockResolvedValueOnce` and the loser silently gets the default.
vi.mock("@/features/device/useWledSink", () => ({
  useActiveWledSink: () => ({
    activeWledIp: activeWledIpMock,
    savedSink: null,
    restoreOutcome: null,
    ready: true,
    markConnected: async () => undefined,
  }),
}));

vi.mock("@/features/hue/useHueOnboarding", () => ({
  useHueOnboarding: () => useHueOnboardingMock(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({ roomMap: null }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

// Stub calibrationApi.listDisplays so DeviceSection mounts without a Tauri backend.
vi.mock("@/features/calibration/calibrationApi", () => ({
  listDisplays: vi.fn<typeof calibrationApiModule.listDisplays>().mockResolvedValue([]),
}));

// WledCategory mounts useActiveWledSink, which reaches the Tauri boundary on
// mount. Unmocked it throws into the hook's own catch, so the section still
// rendered but every test measured the failure branch.
vi.mock("@/features/device/wledApi", () => ({
  discoverWledDevices: vi.fn<typeof wledApiModule.discoverWledDevices>(),
  connectWledSink: vi.fn<typeof wledApiModule.connectWledSink>(),
  testWledBridge: vi.fn<typeof wledApiModule.testWledBridge>(),
  getWledSinkStatus: vi.fn<typeof wledApiModule.getWledSinkStatus>().mockResolvedValue({ connected: false, sink: null }),
}));

// Stub heavy sub-components that make their own invoke calls.
vi.mock("../WledDevicePicker", () => ({
  WledDevicePicker: () => null,
}));

// Stand-in for the real panel: surfaces the two props the persist-banner tests
// care about — the banner it would render, and the save path it would trigger.
vi.mock("../HueChannelMapPanel", () => ({
  HueChannelMapPanel: ({
    persistError,
    onPositionChange,
  }: {
    persistError?: boolean;
    onPositionChange: (updated: unknown[]) => Promise<void>;
  }) => (
    <div>
      <button type="button" onClick={() => { void onPositionChange([]); }}>
        stub:moveChannel
      </button>
      {persistError ? <span>hue:channelMap.saveError</span> : null}
    </div>
  ),
}));

// Path was `./control/…`, which resolves under `__tests__/` and so matched no
// module in the graph — the real picker rendered here for as long as it existed.
vi.mock("../control/LedChipTypePicker", () => ({
  LedChipTypePicker: () => <span>stub:chipTypePicker</span>,
}));

// The group's own store read and its profile/chip pickers are covered in
// UsbStripsCategory.flow.test.tsx; here only the colour order control is
// under test, so it is mounted directly with the transport the page derives.
vi.mock("../device/UsbStripSettings", async () => {
  const { LedColorOrderControl } = await import("../control/LedColorOrderControl");
  return {
    UsbStripSettings: ({ localTransport }: { localTransport: "serial" | "wled" | null }) => (
      <LedColorOrderControl localTransport={localTransport} />
    ),
  };
});

function defaultDeviceConnectionState() {
  return {
    status: "idle",
    ports: [],
    selectedPort: null,
    connectedPort: null,
    isScanning: false,
    isConnecting: false,
    isReconnecting: false,
    isHealthChecking: false,
    canConnect: false,
    statusCard: null,
    latestHealthCheck: null,
    isConnected: false,
    refreshPorts: vi.fn(),
    selectPort: vi.fn(),
    connectSelectedPort: vi.fn(),
    runHealthCheck: vi.fn(),
  };
}

function createHueHookState(overrides: Record<string, unknown> = {}) {
  return {
    step: "ready",
    bridges: [{ id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" }],
    selectedBridgeId: "test-bridge",
    selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
    manualIp: "",
    manualIpError: null,
    credentialState: "valid",
    areaGroups: [],
    selectedAreaId: "test-area",
    selectedArea: { id: "test-area", name: "Test Area", readiness: { ready: true } },
    canStartHue: true,
    isDiscovering: false,
    isPairing: false,
    isLoadingAreas: false,
    isCheckingReadiness: false,
    isValidatingCredential: false,
    isReadinessStale: false,
    status: null,
    runtimeStatus: null,
    runtimeStatusReadFailure: null,
    runtimeTargets: [],
    isRuntimeMutating: false,
    discover: vi.fn(),
    selectBridge: vi.fn(),
    setManualIp: vi.fn(),
    submitManualIp: vi.fn(),
    recheckBridge: vi.fn<() => Promise<void>>(),
    pair: vi.fn(),
    refreshAreas: vi.fn(),
    selectArea: vi.fn(),
    revalidateArea: vi.fn(),
    startRuntime: vi.fn(),
    areaChannels: [],
    retryRuntimeTarget: vi.fn(),
    forgetBridge: async () => null,
    lightNames: {},
    identifyLights: async () => ({ code: "HUE_IDENTIFY_OK" as const, message: "", details: null }),
    ...overrides,
  };
}

async function renderHueTab(state: ReturnType<typeof createHueHookState>) {
  const user = userEvent.setup();
  useHueOnboardingMock.mockReturnValue(state);
  render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);
  const hueTabBtn = screen.getByText("device:page.rail.hueBridges").closest("button")!;
  await user.click(hueTabBtn);
}

describe("HueReadySummaryCard", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("renders idle state with area name and ready pill", async () => {
    await renderHueTab(createHueHookState({
      selectedArea: { id: "test-area", name: "Living Room", readiness: { ready: true } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: null,
      isReadinessStale: false,
    }));

    await waitFor(() => {
      expect(screen.getByText("Living Room")).toBeInTheDocument();
      const pill = document.querySelector(".lm-dcard-pill.is-idle");
      expect(pill).toBeTruthy();
    });
  });

  it("disables start button when readiness is stale", async () => {
    await renderHueTab(createHueHookState({
      canStartHue: false,
      isReadinessStale: true,
      selectedArea: { id: "test-area", name: "Living Room", readiness: { ready: false, reasons: [] } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: null,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hue:actions.start" })).toBeDisabled();
    });
  });

  it("shows streaming pill when runtimeStatus state is Running", async () => {
    await renderHueTab(createHueHookState({
      selectedArea: { id: "test-area", name: "Test Zone", readiness: { ready: true } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: {
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "Streaming",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    }));

    await waitFor(() => {
      const pill = document.querySelector(".lm-dcard-pill.is-streaming");
      expect(pill).toBeTruthy();
    });
  });

  it("tells the user it is checking on its own while it waits for the link button", async () => {
    await renderHueTab(createHueHookState({
      credentialState: "needs_repair",
      isPairing: true,
      selectedAreaId: null,
      selectedArea: null,
      canStartHue: false,
      status: {
        code: "HUE_PAIRING_PENDING_LINK_BUTTON",
        message: "Waiting for the bridge link button to be pressed.",
        details: null,
      },
    }));

    await waitFor(() => {
      expect(screen.getByText("hue:page.pill.awaiting")).toBeInTheDocument();
    });
    const live = screen.getByText("hue:pair.linkButtonHint").closest("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText("hue:page.pill.authError")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "hue:page.cancel" })).toBeInTheDocument();
  });

  it("offers Try again instead of auth error once the link-button window has run out", async () => {
    const pair = vi.fn();
    const selectBridge = vi.fn();
    const user = userEvent.setup();
    await renderHueTab(createHueHookState({
      credentialState: "needs_repair",
      selectedAreaId: null,
      selectedArea: null,
      canStartHue: false,
      pair,
      selectBridge,
      status: {
        code: "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED",
        message: "Press the bridge link button and retry within 30 seconds.",
        details: null,
      },
    }));

    await waitFor(() => {
      expect(screen.getByText("hue:page.pill.timedOut")).toBeInTheDocument();
    });
    expect(screen.queryByText("hue:page.pill.authError")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "hue:pair.tryAgain" }));
    expect(pair).toHaveBeenCalledWith();

    await user.click(screen.getByRole("button", { name: "hue:page.cancel" }));
    expect(selectBridge).toHaveBeenCalledWith(null);
  });

  it("starts pairing straight from + Pair on a discovered bridge", async () => {
    const pair = vi.fn();
    const selectBridge = vi.fn();
    const user = userEvent.setup();
    await renderHueTab(createHueHookState({
      selectedBridgeId: null,
      selectedBridge: null,
      credentialState: "needs_repair",
      selectedAreaId: null,
      selectedArea: null,
      canStartHue: false,
      pair,
      selectBridge,
    }));

    await user.click(await screen.findByRole("button", { name: "hue:page.addBridge" }));
    expect(pair).toHaveBeenCalledWith("test-bridge");
  });

  it("still shows auth error when credentials genuinely expired", async () => {
    await renderHueTab(createHueHookState({
      credentialState: "needs_repair",
      selectedAreaId: null,
      selectedArea: null,
      canStartHue: false,
      status: {
        code: "AUTH_INVALID_RE_PAIR_REQUIRED",
        message: "Bridge rejected the stored application key.",
        details: null,
      },
    }));

    await waitFor(() => {
      expect(screen.getByText("hue:page.pill.authError")).toBeInTheDocument();
    });
  });
});

describe("DeviceSection hue runtime controls", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    stopHueOutputMock.mockClear();
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("keeps Start disabled in stale state and shows revalidate hint", async () => {
    await renderHueTab(createHueHookState({
      credentialState: "valid",
      isValidatingCredential: true,
      isReadinessStale: true,
      canStartHue: true,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hue:actions.start" })).toBeDisabled();
    });
    expect(screen.getAllByText("hue:runtime.checklist.revalidate")[0]).toBeInTheDocument();
  });

  // Through the mode orchestrator, never `stopHue` itself: a running mode that
  // names Hue has to let go of it before the stream stops.
  it("routes stop action to the orchestrator's Hue stop when stream is reconnecting", async () => {
    const user = userEvent.setup();
    await renderHueTab(createHueHookState({
      runtimeStatus: {
        state: "Reconnecting",
        code: "TRANSIENT_RETRY_SCHEDULED",
        message: "reconnecting",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hue:page.stopRetrying" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "hue:page.stopRetrying" }));

    expect(stopHueOutputMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
    expect(stopHueMock).not.toHaveBeenCalled();
  });

  it("routes reconnect action to startRuntime when streaming", async () => {
    const user = userEvent.setup();
    const startRuntime = vi.fn();
    await renderHueTab(createHueHookState({
      startRuntime,
      runtimeStatus: {
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "Streaming",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hue:page.reconnectNow" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "hue:page.reconnectNow" }));

    expect(startRuntime).toHaveBeenCalledTimes(1);
  });

  it("calls retryRuntimeTarget with first target when reconnecting", async () => {
    const user = userEvent.setup();
    const retryRuntimeTarget = vi.fn();

    await renderHueTab(createHueHookState({
      runtimeStatus: {
        state: "Reconnecting",
        code: "TRANSIENT_RETRY_SCHEDULED",
        message: "reconnecting",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
      runtimeTargets: [
        {
          target: "hue",
          state: "Reconnecting",
          code: "TRANSIENT_RETRY_SCHEDULED",
          message: "reconnecting",
          remainingAttempts: 2,
          nextAttemptMs: 1200,
        },
      ],
      retryRuntimeTarget,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hue:page.reconnectNow" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "hue:page.reconnectNow" }));

    expect(retryRuntimeTarget).toHaveBeenCalledWith("hue");
  });
});

// ---------------------------------------------------------------------------
// DeviceSection persist banner visibility
// ---------------------------------------------------------------------------

const SUPPORTED_PORT = { portName: "COM3", product: "CH340", manufacturer: "WCH", isSupported: true };

/** A connected controller whose strip then fails to save into the roster. */
function connectingDeviceState() {
  return {
    ...defaultDeviceConnectionState(),
    ports: [SUPPORTED_PORT],
    connectSelectedPort: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
}

async function connectFirstPort(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "device:page.usb.connect" }));
}

describe("DeviceSection USB tab — persistError banner (A3.6)", () => {
  beforeEach(() => {
    useDeviceConnectionMock.mockReturnValue(connectingDeviceState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("shows the persist error when the connected strip cannot be saved to the roster", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    await connectFirstPort(user);

    await waitFor(() => {
      expect(screen.getByText("device:page.usb.paired.persistError")).toBeInTheDocument();
    });
  });

  it("persist error banner auto-dismisses after 3 seconds", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    await connectFirstPort(user);

    await waitFor(() => {
      expect(screen.getByText("device:page.usb.paired.persistError")).toBeInTheDocument();
    });

    // Real timers: fake ones would have to be installed before the click that
    // arms the 3 s dismissal, which collides with userEvent + waitFor.
    await waitFor(
      () => {
        expect(screen.queryByText("device:page.usb.paired.persistError")).not.toBeInTheDocument();
      },
      { timeout: 4000, interval: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// The USB and Hue persist banners are independent
// ---------------------------------------------------------------------------

const USB_BANNER = "device:page.usb.paired.persistError";
const HUE_BANNER = "hue:channelMap.saveError";

describe("DeviceSection — USB and Hue persist banners are independent", () => {
  beforeEach(async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockReset().mockResolvedValue(undefined);

    useDeviceConnectionMock.mockReturnValue(connectingDeviceState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  const failUsbStripAdd = connectFirstPort;

  async function failHueChannelMove(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByText("stub:moveChannel"));
  }

  it("does not raise the Hue channel-map banner when a USB strip save fails", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    await failUsbStripAdd(user);

    await waitFor(() => {
      expect(screen.getByText(USB_BANNER)).toBeInTheDocument();
    });
    expect(screen.queryByText(HUE_BANNER)).not.toBeInTheDocument();
  });

  it("does not raise the USB strips banner when a Hue channel-position save fails", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    await failHueChannelMove(user);

    await waitFor(() => {
      expect(screen.getByText(HUE_BANNER)).toBeInTheDocument();
    });
    expect(screen.queryByText(USB_BANNER)).not.toBeInTheDocument();
  });

  // Guards the shared-timer half of the bug: two flags sharing one timer ref
  // means whichever path fires last cancels the other banner's dismissal.
  it("dismisses each banner on its own timer when both paths fail in sequence", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockRejectedValue(new Error("disk full"));

    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    await failHueChannelMove(user);
    await waitFor(() => {
      expect(screen.getByText(HUE_BANNER)).toBeInTheDocument();
    });
    const hueRaisedAt = Date.now();

    // Second failure lands mid-way through the Hue banner's 3 s window.
    await new Promise((resolve) => setTimeout(resolve, 1500 - (Date.now() - hueRaisedAt)));
    await failUsbStripAdd(user);
    await waitFor(() => {
      expect(screen.getByText(USB_BANNER)).toBeInTheDocument();
    });

    // The Hue banner must expire ~3 s after it was raised, not be re-armed by
    // the later USB failure — while the USB banner is still on screen.
    await waitFor(
      () => {
        expect(screen.queryByText(HUE_BANNER)).not.toBeInTheDocument();
      },
      { timeout: 3000, interval: 100 },
    );
    expect(screen.getByText(USB_BANNER)).toBeInTheDocument();
  }, 15000);
});

describe("DeviceSection — colour order", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // An earlier suite can leave an unconsumed `mockRejectedValueOnce` behind.
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockReset().mockResolvedValue(undefined);
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("replaces the control with a WLED hint when the local output is WLED", async () => {
    activeWledIpMock = "192.168.1.42";

    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    expect(await screen.findByText("lights:led.colorOrder.wledHint")).toBeInTheDocument();
    expect(screen.queryByText("lights:led.colorOrder.identify.button")).toBeNull();
  });

  it("offers Identify when a serial strip is bound, even with a WLED address saved", async () => {
    activeWledIpMock = "192.168.1.42";
    useDeviceConnectionMock.mockReturnValue({
      ...defaultDeviceConnectionState(),
      isConnected: true,
      connectedPort: "/dev/cu.usbserial-1420",
    });

    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    const identify = await screen.findByRole("button", {
      name: "lights:led.colorOrder.identify.button",
    });
    expect(identify).not.toBeDisabled();
    expect(screen.queryByText("lights:led.colorOrder.wledHint")).toBeNull();
  });

  // The save is all that reaches a running strip: Rust re-applies the mode
  // once a setting it reads is saved (docs/architecture/lighting-transaction.md).
  it("saves a manual order", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    await user.selectOptions(
      await screen.findByLabelText("lights:led.colorOrder.manualLabel"),
      "grb",
    );

    await waitFor(() => expect(shellStore.save).toHaveBeenCalledWith({ ledColorOrder: "grb" }));
  });
});

describe("DeviceSection — what Off does to the Hue lights", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.save).mockReset().mockResolvedValue(undefined);
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
  });

  // Existing installs never saved a choice; they get "turn off".
  it("shows turning the lights off when nothing is saved", async () => {
    await renderHueTab(createHueHookState());

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "hue:offBehavior.turnOff" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });

  it("shows a saved choice to put them back", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.load).mockResolvedValue({ roomMap: null, hueOffBehavior: "restore" } as never);
    try {
      await renderHueTab(createHueHookState());

      await waitFor(() => {
        expect(screen.getByRole("radio", { name: "hue:offBehavior.restore" })).toHaveAttribute(
          "aria-checked",
          "true",
        );
      });
    } finally {
      vi.mocked(shellStore.load).mockResolvedValue({ roomMap: null } as never);
    }
  });

  // Rust reads the saved value when an Off runs: the save is all it takes.
  it("saves the pick", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    const user = userEvent.setup();
    await renderHueTab(createHueHookState());

    await user.click(await screen.findByRole("radio", { name: "hue:offBehavior.restore" }));

    expect(shellStore.save).toHaveBeenCalledWith({ hueOffBehavior: "restore" });
    expect(screen.getByRole("radio", { name: "hue:offBehavior.restore" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("DeviceSection — category scroll position", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  // Categories only toggle `hidden`, so they share `.lm-device-main`'s scroller.
  it("returns to the top when the category changes", async () => {
    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    const main = document.querySelector(".lm-device-main") as HTMLElement;
    expect(main).toBeTruthy();
    main.scrollTop = 420;

    await user.click(screen.getByText("device:page.rail.hueBridges").closest("button")!);

    await waitFor(() => expect(main.scrollTop).toBe(0));
  });

  it("does it again on every switch, not only the first", async () => {
    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    const main = document.querySelector(".lm-device-main") as HTMLElement;
    await user.click(screen.getByText("device:page.rail.hueBridges").closest("button")!);

    main.scrollTop = 300;
    await user.click(screen.getByText("device:page.rail.wled").closest("button")!);

    await waitFor(() => expect(main.scrollTop).toBe(0));
  });
});

describe("the category rail counts what its labels say", () => {
  const badgeFor = (labelKey: string) =>
    screen.getByText(labelKey).closest("button")!.querySelector(".lm-device-cat-cnt");

  // The page reads the store on mount; settling it inside act keeps those
  // updates from landing after the assertion.
  async function renderSettled(hueActive = false) {
    const view = render(<DeviceSection onStopHueOutput={stopHueOutputMock} hueActive={hueActive} />);
    await act(async () => {});
    return view;
  }

  beforeEach(() => {
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  // Every badge means "active". A supported port that is merely plugged in
  // put a "1" beside a header reading "No strips connected".
  it("counts the connected strip, not the ports that enumerate", async () => {
    useDeviceConnectionMock.mockReturnValue({
      ...defaultDeviceConnectionState(),
      ports: [
        { portName: "/dev/cu.usbserial-1420", isSupported: true },
        { portName: "/dev/cu.debug-console", isSupported: false },
      ],
    });

    const { unmount } = await renderSettled();
    expect(badgeFor("device:page.rail.usbStrips")).toBeNull();
    unmount();

    useDeviceConnectionMock.mockReturnValue({
      ...defaultDeviceConnectionState(),
      ports: [{ portName: "/dev/cu.usbserial-1420", isSupported: true }],
      connectedPort: "/dev/cu.usbserial-1420",
      isConnected: true,
    });
    await renderSettled();
    expect(badgeFor("device:page.rail.usbStrips")).toHaveTextContent("1");
    expect(screen.getByTestId("device-category-usb")).toHaveTextContent("device:page.rail.activeLabel");
  });

  it("shows no strip badge when every port is unsupported", async () => {
    useDeviceConnectionMock.mockReturnValue({
      ...defaultDeviceConnectionState(),
      ports: [{ portName: "/dev/cu.Bluetooth-Incoming-Port", isSupported: false }],
    });

    await renderSettled();

    // Zero renders no badge at all, rather than a "0" chip.
    expect(badgeFor("device:page.rail.usbStrips")).toBeNull();
  });

  // A paired bridge that is not streaming used to count too.
  it("counts Hue only while it is active", async () => {
    const { unmount } = await renderSettled();
    expect(badgeFor("device:page.rail.hueBridges")).toBeNull();
    unmount();

    await renderSettled(true);
    expect(badgeFor("device:page.rail.hueBridges")).toHaveTextContent("1");
  });

  it("never badges displays, which have no active state", async () => {
    const { listDisplays } = await import("@/features/calibration/calibrationApi");
    vi.mocked(listDisplays).mockResolvedValueOnce([
      { id: "d1", label: "Built-in", width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 2, isPrimary: true },
    ]);

    await renderSettled();

    expect(await screen.findByText("Built-in")).toBeInTheDocument();
    expect(badgeFor("device:page.rail.displays")).toBeNull();
  });

  it("heads the rail groups Devices and Other", async () => {
    await renderSettled();
    expect(screen.getByText("device:page.rail.devices")).toBeInTheDocument();
    expect(screen.getByText("device:page.rail.other")).toBeInTheDocument();
  });

  it("counts a bound WLED panel, which was hardcoded to zero", async () => {
    activeWledIpMock = "192.168.1.42";

    await renderSettled();

    expect(badgeFor("device:page.rail.wled")).toHaveTextContent("1");
  });

  it("shows no WLED badge when nothing is bound", async () => {
    await renderSettled();

    expect(badgeFor("device:page.rail.wled")).toBeNull();
  });
});

// e2e/specs/shellUiModeToggle.e2e.ts drives the rail by these ids and skips its
// Hue sub-test when `device-category-hue` is missing.
describe("the category rail is addressable by test id", () => {
  beforeEach(() => {
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it.each([
    ["usb", "device:page.rail.usbStrips"],
    ["hue", "device:page.rail.hueBridges"],
    ["wled", "device:page.rail.wled"],
    ["displays", "device:page.rail.displays"],
    ["manual", "device:page.rail.manualEntry"],
  ])("gives the %s rail button its test id", async (category, labelKey) => {
    const user = userEvent.setup();
    render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);

    const button = screen.getByTestId(`device-category-${category}`);
    expect(button).toHaveTextContent(labelKey);

    await user.click(button);
    expect(button).toHaveAttribute("aria-current", "page");
  });

  // The shell hides the Hue notices only while this page says they are up.
  it("reports the category on view, and none once it unmounts", async () => {
    const user = userEvent.setup();
    const onVisibleCategoryChange = vi.fn<(category: string | null) => void>();
    const { unmount } = render(
      <DeviceSection onStopHueOutput={stopHueOutputMock} onVisibleCategoryChange={onVisibleCategoryChange} />,
    );
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith("usb");

    await user.click(screen.getByTestId("device-category-hue"));
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith("hue");

    unmount();
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith(null);
  });
});

// Both mount-time reads were fire-and-forget; a rejection bypassed the
// `[LumaSync]` console bridge and never reached the log file.
describe("DeviceSection — a failed placement read is logged", () => {
  beforeEach(() => {
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("logs both shellStore reads when the store rejects", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(shellStore.load).mockRejectedValue(new Error("store unreadable"));
    try {
      render(<DeviceSection onStopHueOutput={stopHueOutputMock} />);
      await waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "[LumaSync] DeviceSection: loading room-map placements failed:",
          expect.any(Error),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          "[LumaSync] DeviceSection: re-reading paired USB strips failed:",
          expect.any(Error),
        );
      });
    } finally {
      vi.mocked(shellStore.load).mockResolvedValue({ roomMap: null } as never);
      errorSpy.mockRestore();
    }
  });
});
