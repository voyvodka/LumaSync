import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MODE_GUARD_REASONS } from "@/features/mode/state/modeGuard";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { DEFAULT_ROOM_MAP, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";
import type { ShellState } from "@/shared/contracts/shell";
import type { LocalSink } from "@/features/device/localSink";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import { __resetRuntimeHealthForTests } from "@/features/telemetry/runtimeHealthSource";
import { NO_RUNTIME_HEALTH_ISSUES, type RuntimeHealth } from "@/shared/contracts/telemetry";
import { LightsSection, hueUnavailableSubKey } from "../LightsSection";

const { shellStateRef, saveMock, createHueZoneMock, telemetryMock, healthListeners } = vi.hoisted(() => ({
  shellStateRef: { current: {} as Partial<ShellState> },
  saveMock: vi.fn(),
  createHueZoneMock: vi.fn(),
  telemetryMock: vi.fn(),
  healthListeners: [] as Array<(health: RuntimeHealth) => void>,
}));

vi.mock("@/features/telemetry/telemetryApi", () => ({
  getFullTelemetrySnapshot: () => telemetryMock(),
}));

vi.mock("@/features/telemetry/runtimeHealthEventsApi", () => ({
  listenRuntimeHealth: (listener: (health: RuntimeHealth) => void) => {
    healthListeners.push(listener);
    return Promise.resolve(() => {});
  },
}));

beforeEach(() => {
  healthListeners.length = 0;
  __resetRuntimeHealthForTests();
});

function pushHealth(health: Partial<RuntimeHealth>) {
  act(() => {
    for (const listener of healthListeners) listener({ ...NO_RUNTIME_HEALTH_ISSUES, ...health });
  });
}

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(shellStateRef.current),
    save: (partial: Partial<ShellState>) => {
      saveMock(partial);
      return Promise.resolve();
    },
  },
}));

vi.mock("@/features/room-map/roomMapApi", () => ({
  createHueZone: (...args: unknown[]) => {
    createHueZoneMock(...args);
    return Promise.resolve({ status: { code: "HUE_ZONE_CREATED", message: "", details: null }, zones: [], channels: [] });
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        "lights:mode.off.title": "Off",
        "lights:mode.off.subtitle": "Outputs parked",
        "lights:mode.ambilight.title": "Ambilight",
        "lights:mode.ambilight.subtitleFallback": "Live screen capture",
        "lights:mode.solid.title": "Solid",
        "lights:signal.linkBudget.constrained":
          "USB link limit — at 115,200 baud this strip carries about {{fps}} fps.",
        "lights:signal.linkBudget.hint": "Shorten the strip or output over WLED.",
        "lights:dock.outputs": "Outputs",
        "lights:dock.rows.usbName": "USB",
        "lights:dock.rows.usbType": "CH340",
        "lights:dock.rows.usbSubUnavailable": "No strip connected",
        "lights:dock.rows.wledName": "WLED",
        "lights:dock.rows.hueName": "HUE",
        "lights:dock.rows.hueType": "ENTERTAINMENT",
        "lights:dock.rows.hueSubIdle": "Bridge · standby",
        "lights:dock.addAria": "Add Hue zone",
        "lights:dock.addHueZoneTooltip": "Add a Hue zone",
        "lights:dock.addDisabledTooltip": "Finish Hue setup first",
        "roomMap:hueZones.defaultName": "Zone {{N}}",
        "common:compact.scenes.movie": "Movie",
        "common:compact.scenes.game": "Game",
        "common:compact.scenes.music": "Music",
        "common:compact.scenes.chill": "Chill",
        "common:compact.scenes.read": "Read",
        "common:mode.brightness": "Brightness",
        "common:mode.solidColor": "Solid color",
        "common:ui.colorPicker.hexLabel": "HEX",
        "common:ui.colorPicker.rootAriaLabel": "Color picker",
        "common:ui.colorPicker.hueLabel": "Hue",
        "common:ui.colorPicker.svLabel": "Saturation and value",
        "common:ui.colorPicker.recentColors": "Recent",
        "common:ui.colorPicker.recentItemAriaLabel": "Recent colour {{hex}}",
      };

      let value = dict[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          value = value.replace(`{{${k}}}`, String(v));
        }
      }
      return value;
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

describe("hueUnavailableSubKey", () => {
  it("only says not configured when no bridge is paired", () => {
    expect(hueUnavailableSubKey(false, null, true)).toBe("lights:dock.rows.hueSubUnavailable");
    expect(hueUnavailableSubKey(false, "credentialRejected", true)).toBe("lights:dock.rows.hueSubUnavailable");
    expect(hueUnavailableSubKey(true, "credentialRejected", true)).toBe("lights:dock.rows.hueSubKeyRejected");
    expect(hueUnavailableSubKey(true, "unreachable", true)).toBe("lights:dock.rows.hueSubUnreachable");
    expect(hueUnavailableSubKey(true, null, true)).toBe("lights:dock.rows.hueSubChecking");
  });

  it("does not call a bridge unpaired before boot has read the saved pairing", () => {
    expect(hueUnavailableSubKey(false, null, false)).toBe("lights:dock.rows.hueSubChecking");
  });
});

describe("LightsSection", () => {
  it("asks for a re-pair when a paired bridge rejects the key", () => {
    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        localOutputConnected={true}
        localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
        hueConfigured={true}
        hueReachable={false}
        hueProbeVerdict="credentialRejected"
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("lights:dock.rows.hueSubKeyRejected")).toBeInTheDocument();
    expect(screen.queryByText("lights:dock.rows.hueSubUnavailable")).not.toBeInTheDocument();
  });

  // The dock row read "DTLS 20 Hz" beside a green dot for as long as the
  // bridge stayed unreachable, because it only knew the target was active.
  it("names a retrying Hue session instead of quoting the stream rate", () => {
    render(
      <LightsSection
        mode={{ kind: "ambilight" }}
        outputTargets={["hue"]}
        localOutputConnected={false}
        localSink={null}
        hueConfigured={true}
        hueReachable={true}
        hueStreaming={false}
        hueReconnecting={true}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );

    const retrying = screen.getByText("lights:dock.rows.hueSubReconnecting");
    expect(retrying.closest("button")).toHaveClass("is-reconnecting");
    expect(screen.queryByText("lights:dock.rows.hueSubStreaming")).not.toBeInTheDocument();
  });

  // The health reconciler drops "hue" from the active targets on Failed, so
  // the row fell through to "standby" beside the default green dot.
  it("says the Hue stream stopped when the backend reports it Failed", () => {
    render(
      <LightsSection
        mode={{ kind: "ambilight" }}
        outputTargets={["hue"]}
        localOutputConnected={false}
        localSink={null}
        hueConfigured={true}
        hueReachable={true}
        hueStreaming={false}
        hueStreamFailed={true}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );

    const stopped = screen.getByText("lights:dock.rows.hueSubFailed");
    expect(stopped.closest("button")).toHaveClass("is-failed");
    expect(screen.queryByText("Bridge · standby")).not.toBeInTheDocument();
  });

  it("calls onModeChange with ambilight payload when Ambilight is selected", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        localOutputConnected={true}
        localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={onModeChange}
        onOutputTargetsChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Ambilight/ }));

    expect(onModeChange).toHaveBeenCalledWith({
      kind: "ambilight",
      ambilight: { brightness: 1, blackBorderDetection: false, smoothingAlpha: 0.35, saturation: 1 },
    } satisfies LightingModeConfig);
  });

  it("updates solid payload when color is changed in solid mode", async () => {
    const onModeChange = vi.fn();

    function Harness() {
      const [mode, setMode] = useState<LightingModeConfig>({
        kind: "solid",
        solid: { r: 255, g: 255, b: 255, brightness: 1 },
      });

      return (
        <LightsSection
          mode={mode}
          outputTargets={["usb"]}
          localOutputConnected={true}
          localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
          hueConfigured={false}
          hueStreaming={false}
          modeLockReason={null}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            onModeChange(nextMode);
          }}
          onOutputTargetsChange={vi.fn()}
        />
      );
    }

    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Brightness"), {
      target: { value: "35" },
    });
    // Solid colour picker migrated from native <input type="color">
    // to the SVG-native HsvColorPicker. Drive the change through the picker's
    // hex text input — value setter + Enter triggers commitHexDraft.
    const hexInput = screen.getByLabelText("HEX");
    fireEvent.change(hexInput, { target: { value: "#00ff00" } });
    fireEvent.keyDown(hexInput, { key: "Enter" });

    await waitFor(() => {
      expect(onModeChange).toHaveBeenLastCalledWith({
        kind: "solid",
        solid: { r: 0, g: 255, b: 0, brightness: 0.35 },
      } satisfies LightingModeConfig);
    });
  });

  // The reason and its "Open setup" live in the shell notice queue; the page
  // only disables what the lock covers.
  it("keeps controls disabled when lock reason is CALIBRATION_REQUIRED, and leaves the explanation to the notice queue", () => {
    const onModeChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        localOutputConnected={true}
        localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={MODE_GUARD_REASONS.CALIBRATION_REQUIRED}
        onModeChange={onModeChange}
        onOutputTargetsChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Solid/ })).toBeDisabled();

    expect(screen.queryByText("shell:notices.messages.calibrationRequired")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "shell:notices.actions.ledSetup" })).not.toBeInTheDocument();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("toggles hue target when hue is configured and the row is clicked", async () => {
    const user = userEvent.setup();
    const onOutputTargetsChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        localOutputConnected={true}
        localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
        hueConfigured={true}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={onOutputTargetsChange}
      />,
    );

    // Hue is configured but not selected — clicking adds it
    await user.click(screen.getByRole("button", { name: /HUE/ }));

    expect(onOutputTargetsChange).toHaveBeenCalledWith(["usb", "hue"]);
  });
});

// Guard parity with CompactLayout: a mode that needs somewhere to send frames
// must stay unreachable while nothing is connected, and the user must be told
// why. Off is exempt — parking the outputs is always safe.
describe("LightsSection — the local output row names what is actually bound", () => {
  function renderWithSink(localSink: LocalSink | null) {
    const view = render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        localOutputConnected={localSink !== null}
        localSink={localSink}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );
    // Asserted against the row itself rather than the document: "USB" also
    // appears in the status bar, so a loose text query passes even when the
    // dock is wrong — which is exactly how this defect stayed invisible.
    const row = view.container.querySelector(".lm-out-row");
    return { view, row, text: (row?.textContent ?? "").replace(/\s+/g, " ").trim() };
  }

  /**
   * The defect: the row was gated on a serial port and hardcoded to say USB,
   * so a WLED-only setup saw "No strip connected" on a disabled control while
   * Rust was perfectly able to drive the panel through `UsbOutputPlan::Wled`.
   */
  it("offers a WLED panel as a usable output rather than calling it a missing strip", () => {
    const { row, text } = renderWithSink({ transport: "wled", id: "192.168.1.42" });

    expect(text).toContain("WLED");
    expect(text).toContain("192.168.1.42");
    expect(text).not.toContain("CH340");
    expect(text).not.toContain("No strip connected");
    expect(row).not.toHaveClass("is-unavailable");
  });

  it("still names the chip when the bound sink is a serial strip", () => {
    const { text } = renderWithSink({
      transport: "serial",
      id: "/dev/cu.usbserial-1420",
    });

    expect(text).toContain("USB");
    expect(text).toContain("CH340");
    expect(text).not.toContain("WLED");
  });

  // The fallback names one chip; a CP2102 strip labelled CH340 is wrong.
  it("names the product the OS reported instead of the fallback chip", () => {
    const { text } = renderWithSink({
      transport: "serial",
      id: "/dev/cu.SLAB_USBtoUART",
      product: "CP2102 USB to UART Bridge Controller",
    });

    expect(text).toContain("CP2102 USB to UART Bridge Controller");
    expect(text).not.toContain("CH340");
  });

  it("reports nothing connected when neither transport is bound", () => {
    const { row, text } = renderWithSink(null);

    expect(text).toContain("No strip connected");
    expect(row).toHaveClass("is-unavailable");
  });
});

describe("LightsSection — output availability gate", () => {
  async function renderWithOutputs(
    props: Partial<{
      localOutputConnected: boolean;
      hueConfigured: boolean;
      hueReachable: boolean;
      hueProbeVerdict: HueProbeVerdict | null;
      onModeChange: (next: LightingModeConfig) => void;
    }> = {},
  ) {
    // LightsSection hydrates from shellStore on mount; those
    // promises settle after a synchronous test body returns, which is exactly
    // the update React warns about. Flush them here so every caller observes
    // the hydrated component instead of the first paint.
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        localOutputConnected={props.localOutputConnected ?? false}
        localSink={(props.localOutputConnected ?? false) ? { transport: "serial" as const, id: "/dev/cu.usbserial-1420" } : null}
        hueConfigured={props.hueConfigured ?? false}
        hueReachable={props.hueReachable ?? false}
        hueProbeVerdict={props.hueProbeVerdict ?? null}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={props.onModeChange ?? vi.fn()}
        onOutputTargetsChange={vi.fn()}
        />,
      );
    });
    return result;
  }

  beforeEach(() => {
    shellStateRef.current = {};
  });

  // What is missing, and the way to fix it, is said by the shell notice queue
  // (buildShellNotices); a second copy here said it twice in full mode.
  it("disables the non-Off modes when nothing is connected, without an inline banner", async () => {
    const onModeChange = vi.fn();
    await renderWithOutputs({ onModeChange });

    expect(screen.getByRole("radio", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Solid/ })).toBeDisabled();
    // Off parks the outputs — always safe, never gated on having one.
    expect(screen.getByRole("radio", { name: /Off/ })).toBeEnabled();

    expect(screen.queryByText("shell:notices.messages.outputNone")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "shell:notices.actions.devices" })).not.toBeInTheDocument();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("blocks scene presets too — every scene tile activates SOLID", async () => {
    await renderWithOutputs();

    for (const label of ["Movie", "Game", "Music", "Chill", "Read"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  it("treats a configured-but-unreachable bridge as no output", async () => {
    await renderWithOutputs({
      hueConfigured: true,
      hueReachable: false,
      hueProbeVerdict: "unreachable",
    });

    expect(screen.getByRole("radio", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Solid/ })).toBeDisabled();
  });

  // Seen on launch: the Outputs card read "Bridge · checking…" while the banner
  // above it asked the user to pair the bridge that was being checked. The
  // checking notice itself is the queue's (buildShellNotices).
  it("says checking on the Hue row — not that nothing is paired — while the bridge's first probe runs", async () => {
    await renderWithOutputs({ hueConfigured: true, hueReachable: false, hueProbeVerdict: null });

    expect(screen.getByText("lights:dock.rows.hueSubChecking")).toBeInTheDocument();
    expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Solid/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Off/ })).toBeEnabled();
  });

  it("enables the non-Off modes once a reachable bridge is the only output", async () => {
    await renderWithOutputs({ hueConfigured: true, hueReachable: true });

    expect(screen.getByRole("radio", { name: /Ambilight/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Solid/ })).toBeEnabled();
  });
});

// The room map renders exclusively from `RoomMapConfig.zones`; the legacy
// `hueZones` fold is a one-shot migration. See docs/architecture/hue.md.
describe("LightsSection — Add Hue zone", () => {
  const existingZone: HueZone = {
    id: "hue-zone-existing",
    name: "Zone 1",
    entertainmentAreaId: "area-1",
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    scaleX: 0.5,
    scaleY: 0.5,
    scaleZ: 0.5,
    channelIndices: [],
  };

  beforeEach(() => {
    saveMock.mockClear();
    createHueZoneMock.mockClear();
    shellStateRef.current = {
      lastHueAreaId: "area-1",
      roomMapVersion: 7,
      roomMap: { ...DEFAULT_ROOM_MAP, zones: [existingZone] },
    };
  });

  function renderWithHue() {
    return render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["hue"]}
        localOutputConnected={false}
        localSink={null}
        hueConfigured={true}
        hueReachable={true}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );
  }

  it("appends the new zone to roomMap.zones and never writes the legacy hueZones field", async () => {
    const user = userEvent.setup();
    renderWithHue();

    const addButton = await screen.findByRole("button", { name: "Add Hue zone" });
    await waitFor(() => expect(addButton).toHaveAttribute("aria-disabled", "false"));
    await user.click(addButton);

    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const saved = saveMock.mock.calls[0][0] as { roomMap: RoomMapConfig; roomMapVersion: number };
    expect(saved.roomMap).not.toHaveProperty("hueZones");
    expect(saved.roomMap.zones).toHaveLength(2);
    expect(saved.roomMap.zones[0]).toEqual(existingZone);
    expect(saved.roomMap.zones[1]).toMatchObject({
      entertainmentAreaId: "area-1",
      channelIndices: [],
    });
    expect(saved.roomMapVersion).toBe(8);
  });

  it("numbers the new zone from the rendered zone list and omits the deprecated centerColor", async () => {
    const user = userEvent.setup();
    renderWithHue();

    const addButton = await screen.findByRole("button", { name: "Add Hue zone" });
    await waitFor(() => expect(addButton).toHaveAttribute("aria-disabled", "false"));
    await user.click(addButton);

    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const saved = saveMock.mock.calls[0][0] as { roomMap: RoomMapConfig };
    const created = saved.roomMap.zones[1];
    expect(created.name).toBe("Zone 2");
    expect(created).not.toHaveProperty("centerColor");
  });

  it("mirrors the canonical zone list to the backend under the request envelope", async () => {
    const user = userEvent.setup();
    renderWithHue();

    const addButton = await screen.findByRole("button", { name: "Add Hue zone" });
    await waitFor(() => expect(addButton).toHaveAttribute("aria-disabled", "false"));
    await user.click(addButton);

    await waitFor(() => expect(createHueZoneMock).toHaveBeenCalled());

    const payload = createHueZoneMock.mock.calls[0][0] as {
      zone: HueZone;
      existingZones: HueZone[];
    };
    expect(payload.existingZones).toEqual([existingZone]);
    expect(payload.zone.entertainmentAreaId).toBe("area-1");
  });
});

describe("LightsSection — serial link budget note", () => {
  function renderAmbilight() {
    return render(
      <LightsSection
        mode={{ kind: "ambilight", ambilight: { brightness: 1 } }}
        outputTargets={["usb"]}
        localOutputConnected={true}
        localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );
  }

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    telemetryMock.mockReset();
    telemetryMock.mockResolvedValue({ usb: { ...NO_RUNTIME_HEALTH_ISSUES }, hue: null });
    shellStateRef.current = {};
  });

  it("explains the shortfall next to the FPS readout when the link is constrained", async () => {
    renderAmbilight();
    await settle();

    pushHealth({ linkConstrained: true, linkMaxFps: 19.01 });

    const note = screen.getByRole("status");
    expect(note).toHaveTextContent(
      "USB link limit — at 115,200 baud this strip carries about 19 fps.",
    );
    expect(note).toHaveTextContent("Shorten the strip or output over WLED.");
  });

  it("stays silent on a session with no serial link, whatever the flag says", async () => {
    // The 0 sentinel is "no serial link", not "zero fps" — gating on
    // `linkMaxFps < 30` instead of the helper would show the note here.
    renderAmbilight();
    await settle();

    pushHealth({ linkConstrained: true, linkMaxFps: 0 });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays silent on a healthy strip", async () => {
    renderAmbilight();
    await settle();

    pushHealth({ linkConstrained: false, linkMaxFps: 58.2 });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reads the pushed budget and never polls for it", async () => {
    vi.useFakeTimers();
    try {
      renderAmbilight();
      await settle();
      pushHealth({ linkConstrained: true, linkMaxFps: 19.01 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByRole("status")).toBeInTheDocument();
      // The one read seeds the store at first mount; nothing ticks after it.
      expect(telemetryMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LightsSection — Ambilight mode settings card", () => {
  function usbSnapshot() {
    return {
      usb: {
        captureFps: 60,
        sendFps: 58,
        queueHealth: "healthy" as const,
        frameLatencyMs: 12,
        linkConstrained: false,
        linkMaxFps: 60,
      },
      hue: null,
    };
  }

  function renderAmbilight(targets: ("usb" | "hue")[]) {
    return render(
      <LightsSection
        mode={{ kind: "ambilight", ambilight: { brightness: 1 } }}
        outputTargets={targets}
        localOutputConnected={targets.includes("usb")}
        localSink={targets.includes("usb") ? { transport: "serial" as const, id: "/dev/cu.usbserial-1420" } : null}
        hueConfigured={targets.includes("hue")}
        hueReachable={targets.includes("hue")}
        hueStreaming={targets.includes("hue")}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );
  }

  beforeEach(() => {
    telemetryMock.mockReset();
    shellStateRef.current = {};
  });

  it("keeps the tuning controls and shows no live capture readout", async () => {
    telemetryMock.mockResolvedValue(usbSnapshot());
    renderAmbilight(["usb"]);

    expect(await screen.findByText("lights:slab.modeSettingsText")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "lights:signal.profile.brightness" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "lights:signal.profile.saturation" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "lights:signal.profile.blackBorder" })).toBeInTheDocument();
    expect(
      await screen.findByRole("radiogroup", { name: "lights:signal.smoothing.title" }),
    ).toBeInTheDocument();

    expect(screen.queryByText(/\bfps\b|pkt\/s|\d+ms\b/)).not.toBeInTheDocument();
  });

  it("shows no link note when no local output is a target, whatever was pushed", async () => {
    telemetryMock.mockResolvedValue(usbSnapshot());
    await act(async () => {
      renderAmbilight(["hue"]);
    });

    pushHealth({ linkConstrained: true, linkMaxFps: 19.01 });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// Room-aware turns on by itself when the room map has a TV (a template adds
// one), so the dock says so — only while Hue is an output, since nothing else
// is sampled by room position.
describe("LightsSection — room-aware indicator", () => {
  const tvAnchor = { x: 1.5, y: 0, width: 1.2, height: 0.1 };
  const chipName = "roomMap:roomAware.ariaLabel";

  beforeEach(() => {
    shellStateRef.current = {};
  });

  const pausedChipName = "roomMap:roomAware.pausedAriaLabel";

  function renderWithTargets(
    outputTargets: Array<"usb" | "hue">,
    hue: {
      configured?: boolean;
      reachable?: boolean;
      verdict?: "reachable" | "credentialRejected" | "unreachable" | null;
    } = {},
  ) {
    render(
      <LightsSection
        mode={{ kind: "ambilight" }}
        outputTargets={outputTargets}
        localOutputConnected={true}
        localSink={{ transport: "serial", id: "/dev/cu.usbserial-1420" }}
        hueConfigured={hue.configured ?? true}
        hueReachable={hue.reachable ?? true}
        hueProbeVerdict={hue.verdict ?? "reachable"}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
      />,
    );
  }

  it("shows when the room map has a TV and Hue is an output", async () => {
    shellStateRef.current = { roomMap: { ...DEFAULT_ROOM_MAP, tvAnchor } };
    renderWithTargets(["usb", "hue"]);
    expect(await screen.findByRole("button", { name: chipName })).toBeInTheDocument();
  });

  it("stays hidden without a TV anchor", async () => {
    shellStateRef.current = { roomMap: { ...DEFAULT_ROOM_MAP } };
    renderWithTargets(["usb", "hue"]);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: chipName })).not.toBeInTheDocument();
  });

  it("stays hidden when Hue is not an output", async () => {
    shellStateRef.current = { roomMap: { ...DEFAULT_ROOM_MAP, tvAnchor } };
    renderWithTargets(["usb"]);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: chipName })).not.toBeInTheDocument();
  });

  // The audit caught the chip claiming room-aware sampling under a Hue row
  // that said re-pair was required and nothing was streaming.
  it.each([
    ["the key is rejected", "credentialRejected", "roomMap:roomAware.paused.keyRejected"],
    ["the bridge is unreachable", "unreachable", "roomMap:roomAware.paused.unreachable"],
  ] as const)("reads paused, not on, when %s", async (_label, verdict, reasonKey) => {
    shellStateRef.current = { roomMap: { ...DEFAULT_ROOM_MAP, tvAnchor } };
    renderWithTargets(["usb", "hue"], { reachable: false, verdict });
    const chip = await screen.findByRole("button", { name: pausedChipName });
    expect(chip).toHaveTextContent("roomMap:roomAware.pausedLabel");
    expect(screen.queryByRole("button", { name: chipName })).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByText(reasonKey)).toBeVisible();
  });

  it("stays hidden when no bridge is paired", async () => {
    shellStateRef.current = { roomMap: { ...DEFAULT_ROOM_MAP, tvAnchor } };
    renderWithTargets(["usb", "hue"], { configured: false, reachable: false, verdict: null });
    await act(async () => {});
    expect(screen.queryByRole("button", { name: chipName })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: pausedChipName })).not.toBeInTheDocument();
  });
});
