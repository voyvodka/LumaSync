import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HueStartConfig } from "@/features/hue/model/hueStartConfig";
import type { LightingModeConfig } from "@/features/mode/model/contracts";
import type { ModeRuntimeConfig } from "@/features/mode/state/useModeRuntimeConfig";
import { CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";
import { HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import { appliedResult } from "@/test/modeCommandResult";

const setLightingModeMock = vi.fn();
const startHueMock = vi.fn();
const stopHueMock = vi.fn();
const setHueSolidColorMock = vi.fn();

vi.mock("@/features/mode/modeApi", () => ({
  setLightingMode: (payload: LightingModeConfig) => setLightingModeMock(payload),
  startHue: (config: unknown) => startHueMock(config),
  stopHue: (...args: unknown[]) => stopHueMock(...args),
  setHueSolidColor: (payload: unknown) => setHueSolidColorMock(payload),
}));

const loadShellStateMock = vi.fn();
const saveShellStateMock = vi.fn();
const getSerialConnectionStatusMock = vi.fn();

// `restoreLightingSession` touches none of these; the hook-level tests below do.
vi.mock("../windowLifecycle", () => ({
  initWindowLifecycle: vi.fn(() => Promise.resolve()),
  loadShellState: () => loadShellStateMock(),
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
}));
vi.mock("../useTrayIntegration", () => ({ pushTrayLabels: vi.fn() }));
vi.mock("@/features/platform/platformApi", () => ({ showNotification: vi.fn() }));
vi.mock("@/features/device/deviceConnectionApi", () => ({
  getSerialConnectionStatus: () => getSerialConnectionStatusMock(),
}));

import { useModeRuntimeConfig } from "@/features/mode/state/useModeRuntimeConfig";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { restoreLightingSession, useShellBootstrap, type ShellBootstrapSink } from "../useShellBootstrap";

const hueConfig = {
  bridgeIp: "192.168.1.10",
  username: "app-user",
  clientKey: "AABBCCDD11223344",
  areaId: "area-1",
} as HueStartConfig;

const runtimeConfig = { hydrate: (mode: LightingModeConfig) => mode } as unknown as ModeRuntimeConfig;

const ambilight: LightingModeConfig = {
  kind: "ambilight",
  ambilight: { brightness: 0.8, saturation: 1, blackBorderDetection: false },
} as LightingModeConfig;
const solid: LightingModeConfig = {
  kind: "solid",
  solid: { r: 1, g: 2, b: 3, brightness: 0.5 },
} as LightingModeConfig;

const hueRunning = { active: true, status: { code: "HUE_STREAM_RUNNING", message: "ok", details: null } };
const hueRefused = {
  active: false,
  status: { code: "HUE_STREAM_NOT_READY_ACTIVE_STREAMER", message: "busy", details: null },
};
const captureDenied = {
  active: false,
  mode: { kind: "off" },
  status: {
    code: "AMBILIGHT_MODE_START_FAILED",
    message: "Ambilight runtime could not start.",
    details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
  },
};

function restore(mode: LightingModeConfig, bootTargets: Array<"usb" | "hue">) {
  return restoreLightingSession({
    mode,
    bootTargets,
    hueConfig,
    runtimeConfig,
    reportHueSolidColorStatus: vi.fn(),
  });
}

describe("restoreLightingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
      Promise.resolve(appliedResult(payload)),
    );
    startHueMock.mockResolvedValue(hueRunning);
    stopHueMock.mockResolvedValue({ active: false, status: { code: "HUE_STREAM_STOPPED" } });
    setHueSolidColorMock.mockResolvedValue({ status: { code: "HUE_SOLID_COLOR_APPLIED" } });
  });

  it("reports a running session only for the targets that actually started", async () => {
    await expect(restore(ambilight, ["usb", "hue"])).resolves.toEqual({
      running: true,
      activeTargets: ["usb", "hue"],
      startFailure: null,
      hueLeftOut: null,
      hueStartCode: "HUE_STREAM_RUNNING",
    });
    expect(stopHueMock).not.toHaveBeenCalled();
  });

  it("releases the bridge and reports the capture failure when the mode is refused", async () => {
    setLightingModeMock.mockResolvedValue(captureDenied);

    const result = await restore(ambilight, ["hue"]);

    expect(result.running).toBe(false);
    expect(result.activeTargets).toEqual([]);
    expect(result.startFailure?.bucket).toBe(CAPTURE_FAILURE_BUCKET.PERMISSION);
    expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
    expect(stopHueMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      setLightingModeMock.mock.invocationCallOrder[0],
    );
  });

  it("treats a thrown apply as refused and still releases the bridge", async () => {
    setLightingModeMock.mockRejectedValue(new Error("LIGHTING_RUNTIME_STATE_LOCK_FAILED"));

    const result = await restore(solid, ["hue"]);

    expect(result).toEqual({ running: false, activeTargets: [], startFailure: null, hueLeftOut: null, hueStartCode: "HUE_STREAM_RUNNING" });
    expect(stopHueMock).toHaveBeenCalledTimes(1);
    expect(setHueSolidColorMock).not.toHaveBeenCalled();
  });

  it("starts Ambilight after a failed Hue start, as the interactive path does", async () => {
    startHueMock.mockResolvedValue(hueRefused);

    const result = await restore(ambilight, ["hue"]);

    expect(setLightingModeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ running: true, activeTargets: [], startFailure: null, hueLeftOut: null, hueStartCode: "HUE_STREAM_NOT_READY_ACTIVE_STREAMER" });
  });

  // What the real backend answers with the bridge unreachable: the start is
  // gated to Idle with no stream context and no retry loop, so the Hue gate in
  // `set_lighting_mode` refuses. The restore must read that as Off.
  it("reads a gated Hue start as not running, not as a pending retry", async () => {
    startHueMock.mockResolvedValue({
      active: false,
      status: {
        code: "CONFIG_NOT_READY_GATE_BLOCKED",
        state: "Idle",
        message: "blocked",
        details: "Missing prerequisites: readiness",
      },
    });
    setLightingModeMock.mockResolvedValue({
      active: false,
      mode: { kind: "off" },
      status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
    });

    const result = await restore(ambilight, ["hue"]);

    expect(result).toEqual({ running: false, activeTargets: [], startFailure: null, hueLeftOut: null, hueStartCode: "CONFIG_NOT_READY_GATE_BLOCKED" });
    expect(stopHueMock).not.toHaveBeenCalled();
  });

  it("keeps hue listed when the rollback stop does not confirm", async () => {
    setLightingModeMock.mockResolvedValue(captureDenied);
    stopHueMock.mockResolvedValue({ active: true, status: { code: "HUE_STOP_TIMEOUT_PARTIAL" } });

    const result = await restore(ambilight, ["hue"]);

    expect(result.running).toBe(false);
    expect(result.activeTargets).toEqual(["hue"]);
  });

  it("runs nothing for Solid when its only output failed to start", async () => {
    startHueMock.mockResolvedValue(hueRefused);

    const result = await restore(solid, ["hue"]);

    expect(setLightingModeMock).not.toHaveBeenCalled();
    expect(result.running).toBe(false);
  });

  it("starts Hue before the mode and pushes the Solid colour after it", async () => {
    const result = await restore(solid, ["hue"]);

    expect(result).toEqual({ running: true, activeTargets: ["hue"], startFailure: null, hueLeftOut: null, hueStartCode: "HUE_STREAM_RUNNING" });
    expect(startHueMock.mock.invocationCallOrder[0]).toBeLessThan(
      setLightingModeMock.mock.invocationCallOrder[0],
    );
    expect(setHueSolidColorMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      setLightingModeMock.mock.invocationCallOrder[0],
    );
  });

  describe("Hue left out of a [usb, hue] restore", () => {
    const hueGated = {
      active: false,
      mode: { kind: "off" },
      status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
    };

    function gateOnHue() {
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
        Promise.resolve((payload.targets ?? []).includes("hue") ? hueGated : appliedResult(payload)),
      );
    }

    function hueStart(code: string, state = "Idle") {
      return { active: false, status: { code, message: "hue", details: null, state } };
    }

    it("re-dispatches on USB alone and reports the session running without Hue", async () => {
      startHueMock.mockResolvedValue(hueStart("CONFIG_NOT_READY_GATE_BLOCKED"));
      gateOnHue();

      const result = await restore(ambilight, ["usb", "hue"]);

      expect(setLightingModeMock).toHaveBeenCalledTimes(2);
      expect(setLightingModeMock.mock.calls[1][0].targets).toEqual(["usb"]);
      expect(result).toEqual({
        running: true,
        activeTargets: ["usb"],
        startFailure: null,
        hueLeftOut: "unreachable",
        hueStartCode: "CONFIG_NOT_READY_GATE_BLOCKED",
      });
      expect(stopHueMock).not.toHaveBeenCalled();
    });

    it("cancels a start that left Hue retrying", async () => {
      startHueMock.mockResolvedValue(hueStart("TRANSIENT_RETRY_SCHEDULED", "Reconnecting"));
      gateOnHue();

      const result = await restore(solid, ["usb", "hue"]);

      expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
      expect(stopHueMock.mock.invocationCallOrder[0]).toBeLessThan(
        setLightingModeMock.mock.invocationCallOrder[1],
      );
      expect(result.activeTargets).toEqual(["usb"]);
      expect(setHueSolidColorMock).not.toHaveBeenCalled();
    });

    it("names a re-pair for an auth-invalid start", async () => {
      startHueMock.mockResolvedValue(hueStart("AUTH_INVALID_CREDENTIALS", "Failed"));
      gateOnHue();

      const result = await restore(ambilight, ["usb", "hue"]);

      expect(result.hueLeftOut).toBe("auth");
    });

    it("raises nothing when the USB retry is refused too", async () => {
      startHueMock.mockResolvedValue(hueStart("CONFIG_NOT_READY_GATE_BLOCKED"));
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
        Promise.resolve((payload.targets ?? []).includes("hue") ? hueGated : captureDenied),
      );

      const result = await restore(ambilight, ["usb", "hue"]);

      expect(result.running).toBe(false);
      expect(result.hueLeftOut).toBeNull();
      expect(result.startFailure?.bucket).toBe(CAPTURE_FAILURE_BUCKET.PERMISSION);
    });
  });
});

describe("useShellBootstrap with Hue left out", () => {
  function sink(): ShellBootstrapSink {
    return {
      t: ((key: string) => key) as unknown as ShellBootstrapSink["t"],
      setUIMode: vi.fn(),
      setActiveSection: vi.fn(),
      setSavedCalibration: vi.fn(),
      setHasCompletedOnboarding: vi.fn(),
      setHasInteractedWithMode: vi.fn(),
      setLightingMode: vi.fn(),
      setSelectedOutputTargets: vi.fn(),
      setActiveOutputTargets: vi.fn(),
      setHueStartConfig: vi.fn(),
      armUsbConnected: vi.fn(),
      runtimeConfig: {
        hydrate: (mode: LightingModeConfig) => mode,
        setCalibration: vi.fn(),
        prime: vi.fn(),
        setAmbilight: vi.fn(),
      } as unknown as ModeRuntimeConfig,
      reportHueSolidColorStatus: vi.fn(),
      reportStartFailure: vi.fn(),
      reportHueLeftOut: vi.fn(),
      scheduleHueBusyRetry: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadShellStateMock.mockResolvedValue({
      uiMode: "compact",
      lightingMode: { kind: "ambilight" },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { ip: "192.168.1.10" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });
    getSerialConnectionStatusMock.mockResolvedValue({ connected: true });
    startHueMock.mockResolvedValue({
      active: false,
      status: { code: "CONFIG_NOT_READY_GATE_BLOCKED", message: "blocked", details: null, state: "Idle" },
    });
    stopHueMock.mockResolvedValue({ active: false, status: { code: "HUE_STREAM_STOPPED" } });
    setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
      Promise.resolve(
        (payload.targets ?? []).includes("hue")
          ? {
              active: false,
              mode: { kind: "off" },
              status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
            }
          : appliedResult(payload),
      ),
    );
  });

  it("runs on USB, drops Hue for the session only, and hands a gate refusal to the rejoin", async () => {
    const bag = sink();
    const { result } = renderHook(() => useShellBootstrap(bag));
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));

    expect(bag.setActiveOutputTargets).toHaveBeenLastCalledWith(["usb"]);
    expect(bag.setSelectedOutputTargets).toHaveBeenLastCalledWith(["usb"]);
    expect(bag.setLightingMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "ambilight", targets: ["usb"] }),
    );
    // A gate refusal may be a held area, so the notice waits for the rejoin's
    // first probe instead of calling the bridge unreachable outright.
    expect(bag.reportHueLeftOut).not.toHaveBeenCalled();
    expect(bag.scheduleHueBusyRetry).toHaveBeenCalledTimes(1);
    expect(bag.scheduleHueBusyRetry).toHaveBeenCalledWith(
      { type: "rejoin", leftOut: "unreachable" },
      expect.objectContaining({ bridgeIp: "192.168.1.10", areaId: "area-1" }),
    );
    // The next launch must try Hue again: nothing rewrites the persisted set.
    const patches = saveShellStateMock.mock.calls.map(([patch]) => patch as Record<string, unknown>);
    expect(patches.some((patch) => "lastOutputTargets" in patch)).toBe(false);
  });

  it.each([
    ["AUTH_INVALID_CREDENTIALS", "Failed", "auth"],
    ["TRANSIENT_RETRY_SCHEDULED", "Reconnecting", "unreachable"],
  ])("raises the notice at once and never rejoins after a %s start", async (code, state, reason) => {
    startHueMock.mockResolvedValue({
      active: false,
      status: { code, message: "refused", details: null, state },
    });
    const bag = sink();
    const { result } = renderHook(() => useShellBootstrap(bag));
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));

    expect(bag.setActiveOutputTargets).toHaveBeenLastCalledWith(["usb"]);
    expect(bag.reportHueLeftOut).toHaveBeenCalledWith(reason);
    expect(bag.scheduleHueBusyRetry).not.toHaveBeenCalled();
  });
});

describe("useShellBootstrap with the bridge refusing a Hue-only restore", () => {
  function sink(): ShellBootstrapSink {
    return {
      t: ((key: string) => key) as unknown as ShellBootstrapSink["t"],
      setUIMode: vi.fn(),
      setActiveSection: vi.fn(),
      setSavedCalibration: vi.fn(),
      setHasCompletedOnboarding: vi.fn(),
      setHasInteractedWithMode: vi.fn(),
      setLightingMode: vi.fn(),
      setSelectedOutputTargets: vi.fn(),
      setActiveOutputTargets: vi.fn(),
      setHueStartConfig: vi.fn(),
      armUsbConnected: vi.fn(),
      runtimeConfig: {
        hydrate: (mode: LightingModeConfig) => mode,
        setCalibration: vi.fn(),
        prime: vi.fn(),
        setAmbilight: vi.fn(),
      } as unknown as ModeRuntimeConfig,
      reportHueSolidColorStatus: vi.fn(),
      reportStartFailure: vi.fn(),
      reportHueLeftOut: vi.fn(),
      scheduleHueBusyRetry: vi.fn(),
    };
  }

  function hueStartAnswers(code: string, state: string) {
    startHueMock.mockResolvedValue({
      active: false,
      status: { code, message: "refused", details: null, state },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadShellStateMock.mockResolvedValue({
      uiMode: "compact",
      lightingMode: { kind: "ambilight" },
      lastOutputTargets: ["hue"],
      lastHueBridge: { ip: "192.168.1.10" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });
    getSerialConnectionStatusMock.mockResolvedValue({ connected: false });
    setLightingModeMock.mockResolvedValue({
      active: false,
      mode: { kind: "off" },
      status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
    });
  });

  it("shows Off and hands a gate refusal to the busy retry", async () => {
    hueStartAnswers("CONFIG_NOT_READY_GATE_BLOCKED", "Idle");
    const bag = sink();
    const { result } = renderHook(() => useShellBootstrap(bag));
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));

    expect(bag.setLightingMode).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "off" }));
    expect(bag.scheduleHueBusyRetry).toHaveBeenCalledTimes(1);
    expect(bag.scheduleHueBusyRetry).toHaveBeenCalledWith(
      { type: "resume", mode: expect.objectContaining({ kind: "ambilight" }) },
      expect.objectContaining({ bridgeIp: "192.168.1.10", areaId: "area-1" }),
    );
  });

  it.each([
    ["AUTH_INVALID_CREDENTIALS", "Failed"],
    ["AUTH_INVALID_RE_PAIR_REQUIRED", "Failed"],
    ["TRANSIENT_RETRY_EXHAUSTED", "Failed"],
  ])("never retries a %s refusal", async (code, state) => {
    hueStartAnswers(code, state);
    const bag = sink();
    const { result } = renderHook(() => useShellBootstrap(bag));
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));

    expect(bag.setLightingMode).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "off" }));
    expect(bag.scheduleHueBusyRetry).not.toHaveBeenCalled();
  });
});

describe("useShellBootstrap room geometry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadShellStateMock.mockResolvedValue({
      uiMode: "compact",
      lightingMode: { kind: "ambilight", ambilight: { brightness: 1 } },
      lastOutputTargets: ["hue"],
      lastHueBridge: { ip: "192.168.1.10" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
      roomMap: {
        ...DEFAULT_ROOM_MAP,
        hueChannels: [
          { channelIndex: 0, channelId: 3, x: 0.2, y: 0.8, z: 0, entertainmentAreaId: "area-1" },
        ],
        tvAnchor: { x: 1.5, y: 0, width: 2, height: 0.3, mountHeightMeters: 1 },
      },
    });
    getSerialConnectionStatusMock.mockResolvedValue({ connected: false });
    startHueMock.mockResolvedValue(hueRunning);
    setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
      Promise.resolve(appliedResult(payload)),
    );
  });

  it("primes the geometry before the restore dispatch fires", async () => {
    const { result } = renderHook(() => {
      const runtimeConfig = useModeRuntimeConfig({ calibration: undefined });
      return useShellBootstrap({
        t: ((key: string) => key) as unknown as ShellBootstrapSink["t"],
        setUIMode: vi.fn(),
        setActiveSection: vi.fn(),
        setSavedCalibration: vi.fn(),
        setHasCompletedOnboarding: vi.fn(),
        setHasInteractedWithMode: vi.fn(),
        setLightingMode: vi.fn(),
        setSelectedOutputTargets: vi.fn(),
        setActiveOutputTargets: vi.fn(),
        setHueStartConfig: vi.fn(),
        armUsbConnected: vi.fn(),
        runtimeConfig,
        reportHueSolidColorStatus: vi.fn(),
        reportStartFailure: vi.fn(),
        reportHueLeftOut: vi.fn(),
        scheduleHueBusyRetry: vi.fn(),
      });
    });
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));

    expect(setLightingModeMock).toHaveBeenCalledTimes(1);
    // Unknown height origin: the placement is sent without `positionZ`.
    expect((setLightingModeMock.mock.calls[0][0] as LightingModeConfig).roomGeometry).toEqual({
      dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
      tv: { x: 1.5, y: 0, width: 2, height: 0.3, mountHeightMeters: 1 },
      huePlacements: [{ channelId: 3, positionX: 0.2, positionY: 0.8 }],
    });
  });
});
