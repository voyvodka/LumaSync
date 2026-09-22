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

// The module also pulls in window lifecycle, tray and platform bridges; none of
// them run from `restoreLightingSession`, so they only need to import cleanly.
vi.mock("../windowLifecycle", () => ({ initWindowLifecycle: vi.fn(), loadShellState: vi.fn() }));
vi.mock("../useTrayIntegration", () => ({ pushTrayLabels: vi.fn() }));
vi.mock("@/features/platform/platformApi", () => ({ showNotification: vi.fn() }));
vi.mock("@/features/device/deviceConnectionApi", () => ({ getSerialConnectionStatus: vi.fn() }));

import { restoreLightingSession } from "../useShellBootstrap";

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

    expect(result).toEqual({ running: false, activeTargets: [], startFailure: null });
    expect(stopHueMock).toHaveBeenCalledTimes(1);
    expect(setHueSolidColorMock).not.toHaveBeenCalled();
  });

  it("starts Ambilight after a failed Hue start, as the interactive path does", async () => {
    startHueMock.mockResolvedValue(hueRefused);

    const result = await restore(ambilight, ["hue"]);

    expect(setLightingModeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ running: true, activeTargets: [], startFailure: null });
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

    expect(result).toEqual({ running: false, activeTargets: [], startFailure: null });
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

    expect(result).toEqual({ running: true, activeTargets: ["hue"], startFailure: null });
    expect(startHueMock.mock.invocationCallOrder[0]).toBeLessThan(
      setLightingModeMock.mock.invocationCallOrder[0],
    );
    expect(setHueSolidColorMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      setLightingModeMock.mock.invocationCallOrder[0],
    );
  });
});
