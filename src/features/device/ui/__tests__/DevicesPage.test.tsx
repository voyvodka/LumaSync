import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import { DevicesPage } from "../DevicesPage";
import { primaryStripOf } from "@/features/strips/model/stripSelectors";
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
    onSaved: () => () => {},
    save: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(async (update: (current: object) => object | null) => update({ roomMap: null })),
  },
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
vi.mock("@/features/settings/sections/WledDevicePicker", () => ({
  WledDevicePicker: () => null,
}));

// Stand-in for the real panel: surfaces the two props the persist-banner tests
// care about — the banner it would render, and the save path it would trigger.
vi.mock("@/features/settings/sections/HueChannelMapPanel", () => ({
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
vi.mock("@/features/settings/sections/control/LedChipTypePicker", () => ({
  LedChipTypePicker: () => <span>stub:chipTypePicker</span>,
}));

// The group's own store read and its profile/chip pickers are covered in
// UsbStripsCategory.flow.test.tsx; here only the colour order control is
// under test, so it is mounted directly with the transport the page derives.
vi.mock("@/features/settings/sections/device/UsbStripSettings", async () => {
  const { LedColorOrderControl } = await import("@/features/settings/sections/control/LedColorOrderControl");
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
  render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);
  await user.click(await screen.findByTestId("device-entry-hue"));
}


describe("DevicesPage — Hue page states", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("renders the ready state with the area name", async () => {
    await renderHueTab(createHueHookState({
      selectedArea: { id: "test-area", name: "Living Room", readiness: { ready: true } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: null,
      isReadinessStale: false,
    }));

    await waitFor(() => {
      expect(screen.getByTestId("hue-area-row")).toHaveTextContent("Living Room");
      expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.idle");
    });
  });

  // Start used to sit here disabled for as long as the state lasted; Validate is the way on.
  it("offers Validate, not a Start that cannot be pressed, when readiness is stale", async () => {
    await renderHueTab(createHueHookState({
      canStartHue: false,
      isReadinessStale: true,
      selectedArea: { id: "test-area", name: "Living Room", readiness: { ready: false, reasons: [] } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: null,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "hue:page.validate" }).className).toMatch(/primary/);
    });
    expect(screen.queryByRole("button", { name: "hue:actions.start" })).toBeNull();
  });

  it("says Streaming when runtimeStatus state is Running", async () => {
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
      expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.streaming");
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
      expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.pairingLinkButton");
    });
    const live = screen.getByText("hue:pair.linkButtonHint").closest("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText("hue:state.authError")).not.toBeInTheDocument();
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
      expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.pairingTimedOut");
    });
    expect(screen.queryByText("hue:state.authError")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "hue:pair.tryAgain" }));
    expect(pair).toHaveBeenCalledWith();

    await user.click(screen.getByRole("button", { name: "hue:page.cancel" }));
    expect(selectBridge).toHaveBeenCalledWith(null);
  });

  it("starts pairing straight from Pair on a discovered bridge", async () => {
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

    await user.click(await screen.findByRole("button", { name: "hue:page.pairNamed" }));
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
      expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.authError");
    });
  });
});

describe("DevicesPage hue runtime controls", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    stopHueOutputMock.mockClear();
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("shows the revalidate hint and no Start in the stale state", async () => {
    await renderHueTab(createHueHookState({
      credentialState: "valid",
      isValidatingCredential: true,
      isReadinessStale: true,
      canStartHue: true,
    }));

    await waitFor(() => {
      expect(screen.getAllByText("hue:runtime.checklist.revalidate")[0]).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "hue:actions.start" })).toBeNull();
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

  it("routes reconnect, behind …, to startRuntime when streaming", async () => {
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

    await user.click(await screen.findByRole("button", { name: "hue:page.more" }));
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
// Persist banner visibility
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

describe("DevicesPage USB tab — persistError banner (A3.6)", () => {
  beforeEach(() => {
    useDeviceConnectionMock.mockReturnValue(connectingDeviceState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("shows the persist error when the connected strip cannot be saved to the roster", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.update).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

    await connectFirstPort(user);

    await waitFor(() => {
      expect(screen.getByText("device:page.usb.paired.persistError")).toBeInTheDocument();
    });
  });

  it("persist error banner auto-dismisses after 3 seconds", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    vi.mocked(shellStore.update).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

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

describe("DevicesPage — USB and Hue persist banners are independent", () => {
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
    vi.mocked(shellStore.update).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

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
    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

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
    vi.mocked(shellStore.update).mockRejectedValueOnce(new Error("disk full"));

    const user = userEvent.setup();
    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

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

describe("DevicesPage — colour order", () => {
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

    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

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

    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

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
    render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

    await user.selectOptions(
      await screen.findByLabelText("lights:led.colorOrder.manualLabel"),
      "grb",
    );

    await waitFor(() => expect(shellStore.update).toHaveBeenCalled());
    const results = vi.mocked(shellStore.update).mock.results;
    const written = await results[results.length - 1]!.value;
    expect(primaryStripOf(written)?.hardware.colorOrder).toBe("grb");
  });
});

describe("DevicesPage — what Off does to the Hue lights", () => {
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

const SERIAL_STRIP = {
  id: "strip-1",
  enabled: true,
  transport: { kind: "serial", portName: "/dev/cu.usbserial-1420" },
  hardware: {},
};
const WLED_STRIP = {
  id: "strip-2",
  enabled: true,
  transport: { kind: "wled", sink: { ip: "192.168.1.42", port: 21324, ledCount: 60, protocol: "drgb" } },
  hardware: {},
};

async function withStrips(strips: unknown[]) {
  const { shellStore } = await import("@/features/persistence/shellStore");
  vi.mocked(shellStore.load).mockResolvedValue({ roomMap: null, ledStrips: strips } as never);
}

// The page reads the strips from the store on mount; settling it inside act keeps those updates
// from landing after the assertion.
async function renderSettled(props: Partial<React.ComponentProps<typeof DevicesPage>> = {}) {
  const view = render(<DevicesPage onStopHueOutput={stopHueOutputMock} {...props} />);
  await act(async () => {});
  return view;
}

const rowLabels = () => within(screen.getByRole("navigation", { name: "device:page.rail.label" }))
  .getAllByRole("button")
  .map((button) => button.textContent);

describe("DevicesPage — the rail lists the devices", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    activeWledIpMock = null;
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
    await withStrips([]);
  });

  it("with nothing added, offers a bridge and a strip to add", async () => {
    useHueOnboardingMock.mockReturnValue(
      createHueHookState({ bridges: [], selectedBridge: null, selectedBridgeId: null, credentials: null }),
    );
    await renderSettled();

    expect(rowLabels()).toEqual(["device:page.rail.addStrip", "device:page.rail.addBridge"]);
    expect(screen.getByTestId("device-entry-add")).toHaveAttribute("aria-current", "page");
  });

  // The name holds still whether the controller is plugged in or not; a bridge that reports no name
  // is shown without the address Rust appends to it.
  it("names a USB strip plainly, a WLED strip by its address, and dots the connected one", async () => {
    await withStrips([SERIAL_STRIP, WLED_STRIP]);
    useHueOnboardingMock.mockReturnValue(
      createHueHookState({ selectedBridge: { id: "test-bridge", name: "Hue Bridge (192.168.1.100)", ip: "192.168.1.100" } }),
    );
    useDeviceConnectionMock.mockReturnValue({
      ...defaultDeviceConnectionState(),
      ports: [{ portName: "/dev/cu.usbserial-1420", isSupported: true, product: "USB Serial" }],
      connectedPort: "/dev/cu.usbserial-1420",
      isConnected: true,
    });
    await renderSettled();

    expect(rowLabels()).toEqual([
      "device:page.rail.usbStrip, device:page.rail.on",
      "device:page.rail.wledStrip, device:page.rail.off",
      "device:page.rail.addStrip",
      "Hue Bridge, device:page.rail.off",
    ]);
    // The first strip is where the page opens.
    expect(screen.getAllByTestId("device-entry-strip")[0]).toHaveAttribute("aria-current", "page");
  });

  it("numbers strips of the same kind", async () => {
    await withStrips([SERIAL_STRIP, { ...SERIAL_STRIP, id: "strip-3", transport: { kind: "serial", portName: "COM4" } }]);
    await renderSettled();

    expect(rowLabels().slice(0, 2)).toEqual([
      "device:page.rail.usbStrip 1, device:page.rail.off",
      "device:page.rail.usbStrip 2, device:page.rail.off",
    ]);
  });

  // Plugged in but not added: a faint row to add it, not a device.
  it("offers a supported port no strip is bound to, and never an unsupported one", async () => {
    const selectPort = vi.fn<(portName: string | null) => void>();
    useDeviceConnectionMock.mockReturnValue({
      ...defaultDeviceConnectionState(),
      selectPort,
      ports: [
        { portName: "/dev/cu.usbserial-1420", isSupported: true, product: "USB Serial" },
        { portName: "/dev/cu.debug-console", isSupported: false },
      ],
    });
    await renderSettled();

    // Last, in its own group: a cable plugged in never moves a row above it.
    expect(rowLabels()).toEqual(["device:page.rail.addStrip", "Test Bridge, device:page.rail.off", "device:page.rail.addPort"]);
    expect(screen.getByRole("group", { name: "device:page.rail.found" })).toContainElement(
      screen.getByTestId("device-entry-port"),
    );
    await userEvent.setup().click(screen.getByTestId("device-entry-port"));
    expect(selectPort).toHaveBeenCalledWith("/dev/cu.usbserial-1420");
  });

  // Found and not paired, with the paired bridge already on the Hue row: offered, not taken over.
  it("offers found bridges last, by address when two share a name", async () => {
    useHueOnboardingMock.mockReturnValue(
      createHueHookState({
        bridges: [
          { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
          { id: "b2", name: "Hue Bridge (192.168.1.181)", ip: "192.168.1.181" },
          { id: "b3", name: "Hue Bridge (192.168.1.182)", ip: "192.168.1.182" },
        ],
      }),
    );
    const onVisibleCategoryChange = vi.fn<(category: string | null) => void>();
    await renderSettled({ onVisibleCategoryChange });

    const found = screen.getByRole("group", { name: "device:page.rail.found" });
    expect(within(found).getAllByRole("button")).toHaveLength(2);
    expect(rowLabels()).toContain("Test Bridge, device:page.rail.off");
    await userEvent.setup().click(within(found).getAllByRole("button")[0]!);
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith("hue");
  });

  // Its row goes once it is paired; the page stays on the bridge, now as the Hue row.
  it("opens a found bridge's own page, and lands on the Hue row once it is paired", async () => {
    const office = { id: "b2", name: "Office", ip: "192.168.1.181" };
    const bridges = [{ id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" }, office];
    useHueOnboardingMock.mockReturnValue(createHueHookState({ bridges }));
    const view = await renderSettled();

    const found = screen.getByRole("group", { name: "device:page.rail.found" });
    await userEvent.setup().click(within(found).getByRole("button"));
    expect(screen.getByRole("heading", { name: "Office" })).toBeInTheDocument();

    useHueOnboardingMock.mockReturnValue(
      createHueHookState({ bridges, selectedBridgeId: office.id, selectedBridge: office, credentials: { username: "u", clientKey: "k" } }),
    );
    view.rerender(<DevicesPage onStopHueOutput={stopHueOutputMock} />);

    // One found bridge still: the one it replaced.
    expect(screen.getAllByTestId("device-entry-bridge")).toHaveLength(1);
    expect(screen.getByTestId("device-entry-hue")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Office" })).toBeInTheDocument();
  });

  it("dots the bridge while it streams", async () => {
    const { unmount } = await renderSettled();
    expect(screen.getByTestId("device-entry-hue")).toHaveTextContent("device:page.rail.off");
    unmount();

    await renderSettled({ hueActive: true });
    expect(screen.getByTestId("device-entry-hue")).toHaveTextContent("device:page.rail.on");
  });

  // Rows only toggle `hidden`, so they share the page's one scroller, beside the rail.
  it("returns to the top when the row changes, every time", async () => {
    const user = userEvent.setup();
    await renderSettled();
    const main = document.querySelector("nav")!.nextElementSibling as HTMLElement;

    main.scrollTop = 420;
    await user.click(screen.getByTestId("device-entry-hue"));
    await waitFor(() => expect(main.scrollTop).toBe(0));

    main.scrollTop = 300;
    await user.click(screen.getByTestId("device-entry-add"));
    await waitFor(() => expect(main.scrollTop).toBe(0));
  });

  it("opens on the row left open when the section comes back, until a new deep link", async () => {
    await withStrips([SERIAL_STRIP]);
    const user = userEvent.setup();
    const first = await renderSettled();
    await user.click(screen.getByTestId("device-entry-hue"));
    first.unmount();

    const back = await renderSettled();
    expect(screen.getByTestId("device-entry-hue")).toHaveAttribute("aria-current", "page");
    back.unmount();

    const request = { category: "strips" as const, nonce: 1 };
    const linked = await renderSettled({ categoryRequest: request });
    expect(screen.getByTestId("device-entry-strip")).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByTestId("device-entry-hue"));
    linked.unmount();

    // The same request still held by the shell is not a new one.
    await renderSettled({ categoryRequest: request });
    expect(screen.getByTestId("device-entry-hue")).toHaveAttribute("aria-current", "page");
  });

  // The shell hides the Hue notices only while this page says they are up.
  it("reports the category on view, and none once it unmounts", async () => {
    const user = userEvent.setup();
    const onVisibleCategoryChange = vi.fn<(category: string | null) => void>();
    const { unmount } = await renderSettled({ onVisibleCategoryChange });
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith("strips");

    await user.click(screen.getByTestId("device-entry-hue"));
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith("hue");

    unmount();
    expect(onVisibleCategoryChange).toHaveBeenLastCalledWith(null);
  });
});

describe("DevicesPage — a failed placement read is logged", () => {
  beforeEach(() => {
    useDeviceConnectionMock.mockReturnValue(defaultDeviceConnectionState());
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("logs both shellStore reads when the store rejects", async () => {
    const { shellStore } = await import("@/features/persistence/shellStore");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(shellStore.load).mockRejectedValue(new Error("store unreadable"));
    try {
      render(<DevicesPage onStopHueOutput={stopHueOutputMock} />);
      await waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          "[LumaSync] Devices: loading room-map placements failed:",
          expect.any(Error),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          "[LumaSync] Devices: re-reading paired USB strips failed:",
          expect.any(Error),
        );
      });
    } finally {
      vi.mocked(shellStore.load).mockResolvedValue({ roomMap: null } as never);
      errorSpy.mockRestore();
    }
  });
});
