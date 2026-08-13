import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MODE_GUARD_REASONS } from "@/features/mode/state/modeGuard";
import type { LightingModeConfig } from "@/features/mode/model/contracts";
import { DEFAULT_ROOM_MAP, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";
import type { ShellState } from "@/shared/contracts/shell";
import { LightsSection } from "../LightsSection";

const { shellStateRef, saveMock, createHueZoneMock, telemetryMock } = vi.hoisted(() => ({
  shellStateRef: { current: {} as Partial<ShellState> },
  saveMock: vi.fn(),
  createHueZoneMock: vi.fn(),
  telemetryMock: vi.fn(),
}));

vi.mock("@/features/telemetry/telemetryApi", () => ({
  getFullTelemetrySnapshot: () => telemetryMock(),
}));

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

vi.mock("@/features/calibration/calibrationApi", () => ({
  listDisplays: () => Promise.resolve([]),
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
        "lights:calibrationBanner.title": "Calibration required",
        "lights:calibrationBanner.sub": "Finish LED layout before enabling this mode.",
        "lights:calibrationBanner.action": "Open calibration",
        "common:output.offline.title": "No reachable output",
        "common:output.offline.body":
          "Connect a USB LED strip or pair a Hue bridge to enable lighting modes.",
        "common:output.offline.action": "Open devices",
        "common:output.offline.stoppedBody":
          "LumaSync stopped checking for your Hue bridge — it did not answer on this network.",
        "common:output.offline.retry": "Check again",
        "lights:signal.linkBudget.constrained":
          "USB link limit — at 115,200 baud this strip carries about {{fps}} fps.",
        "lights:signal.linkBudget.hint": "Shorten the strip or output over WLED.",
        "lights:dock.outputs": "Outputs",
        "lights:dock.rows.usbName": "USB",
        "lights:dock.rows.usbType": "CH340",
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

describe("LightsSection", () => {
  it("calls onModeChange with ambilight payload when Ambilight is selected", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={onModeChange}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Ambilight/ }));

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
          usbConnected={true}
          hueConfigured={false}
          hueStreaming={false}
          modeLockReason={null}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            onModeChange(nextMode);
          }}
          onOutputTargetsChange={vi.fn()}
          onOpenCalibration={vi.fn()}
        />
      );
    }

    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Brightness"), {
      target: { value: "35" },
    });
    // v1.5 W1-A7: solid colour picker migrated from native <input type="color">
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

  it("keeps controls disabled and opens calibration CTA when lock reason is CALIBRATION_REQUIRED", async () => {
    const user = userEvent.setup();
    const onOpenCalibration = vi.fn();
    const onModeChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={MODE_GUARD_REASONS.CALIBRATION_REQUIRED}
        onModeChange={onModeChange}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={onOpenCalibration}
      />,
    );

    expect(screen.getByRole("button", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Solid/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Open calibration" }));

    expect(onOpenCalibration).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("toggles hue target when hue is configured and the row is clicked", async () => {
    const user = userEvent.setup();
    const onOutputTargetsChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={true}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={onOutputTargetsChange}
        onOpenCalibration={vi.fn()}
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
describe("LightsSection — output availability gate", () => {
  function renderWithOutputs(
    props: Partial<{
      usbConnected: boolean;
      hueConfigured: boolean;
      hueReachable: boolean;
      hueProbeGaveUp: boolean;
      onRetryHueProbe: () => void;
      onOpenDevices: () => void;
      onModeChange: (next: LightingModeConfig) => void;
    }> = {},
  ) {
    return render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={props.usbConnected ?? false}
        hueConfigured={props.hueConfigured ?? false}
        hueReachable={props.hueReachable ?? false}
        hueProbeGaveUp={props.hueProbeGaveUp ?? false}
        onRetryHueProbe={props.onRetryHueProbe}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={props.onModeChange ?? vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={vi.fn()}
        onOpenDevices={props.onOpenDevices}
      />,
    );
  }

  beforeEach(() => {
    shellStateRef.current = {};
  });

  it("disables the non-Off modes and explains why when nothing is connected", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    const onOpenDevices = vi.fn();
    renderWithOutputs({ onModeChange, onOpenDevices });

    expect(screen.getByRole("button", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Solid/ })).toBeDisabled();
    // Off parks the outputs — always safe, never gated on having one.
    expect(screen.getByRole("button", { name: /Off/ })).toBeEnabled();

    expect(screen.getByText("No reachable output")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect a USB LED strip or pair a Hue bridge to enable lighting modes.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open devices" }));
    expect(onOpenDevices).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("offers a manual retry once the bridge probe has given up", async () => {
    const user = userEvent.setup();
    const onRetryHueProbe = vi.fn();
    renderWithOutputs({ hueConfigured: true, hueProbeGaveUp: true, onRetryHueProbe });

    expect(
      screen.getByText(
        "LumaSync stopped checking for your Hue bridge — it did not answer on this network.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRetryHueProbe).toHaveBeenCalledOnce();
  });

  it("hides the retry while the probe is still trying", () => {
    renderWithOutputs({ hueConfigured: true, onRetryHueProbe: vi.fn() });

    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect a USB LED strip or pair a Hue bridge to enable lighting modes.",
      ),
    ).toBeInTheDocument();
  });

  it("blocks scene presets too — every scene tile activates SOLID", () => {
    renderWithOutputs();

    for (const label of ["Movie", "Game", "Music", "Chill", "Read"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  it("treats a configured-but-unreachable bridge as no output", () => {
    renderWithOutputs({ hueConfigured: true, hueReachable: false });

    expect(screen.getByRole("button", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByText("No reachable output")).toBeInTheDocument();
  });

  it("enables the non-Off modes once a reachable bridge is the only output", () => {
    renderWithOutputs({ hueConfigured: true, hueReachable: true });

    expect(screen.getByRole("button", { name: /Ambilight/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Solid/ })).toBeEnabled();
    expect(screen.queryByText("No reachable output")).not.toBeInTheDocument();
  });

  it("keeps the calibration reason distinct from the offline reason", () => {
    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={MODE_GUARD_REASONS.CALIBRATION_REQUIRED}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={vi.fn()}
        onOpenDevices={vi.fn()}
      />,
    );

    expect(screen.getByText("Calibration required")).toBeInTheDocument();
    expect(screen.queryByText("No reachable output")).not.toBeInTheDocument();
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
        usbConnected={false}
        hueConfigured={true}
        hueReachable={true}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={vi.fn()}
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
  function snapshot(linkConstrained: boolean, linkMaxFps: number) {
    return {
      usb: {
        captureFps: 60,
        sendFps: 19,
        queueHealth: "healthy" as const,
        frameLatencyMs: 12,
        linkConstrained,
        linkMaxFps,
      },
      hue: null,
    };
  }

  function renderAmbilight() {
    return render(
      <LightsSection
        mode={{ kind: "ambilight", ambilight: { brightness: 1 } }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={vi.fn()}
      />,
    );
  }

  beforeEach(() => {
    telemetryMock.mockReset();
    shellStateRef.current = {};
  });

  it("explains the shortfall next to the FPS readout when the link is constrained", async () => {
    telemetryMock.mockResolvedValue(snapshot(true, 19.01));
    renderAmbilight();

    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent(
      "USB link limit — at 115,200 baud this strip carries about 19 fps.",
    );
    expect(note).toHaveTextContent("Shorten the strip or output over WLED.");
  });

  it("stays silent on a session with no serial link, whatever the flag says", async () => {
    // The 0 sentinel is "no serial link", not "zero fps" — gating on
    // `linkMaxFps < 30` instead of the helper would show the note here.
    telemetryMock.mockResolvedValue(snapshot(true, 0));
    renderAmbilight();

    await waitFor(() => expect(telemetryMock).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays silent on a healthy strip", async () => {
    telemetryMock.mockResolvedValue(snapshot(false, 58.2));
    renderAmbilight();

    await waitFor(() => expect(telemetryMock).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
