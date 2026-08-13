import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appliedResult } from "@/test/modeCommandResult";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../../model/contracts";
import {
  useLightingModeOrchestrator,
  type LightingModeOrchestratorInput,
} from "../useLightingModeOrchestrator";

const setLightingModeMock = vi.fn();
const stopLightingMock = vi.fn();
const stopHueMock = vi.fn();
const startHueMock = vi.fn();
const setHueSolidColorMock = vi.fn();
const saveShellStateMock = vi.fn();
const loadShellStateMock = vi.fn();
const getScreenCapturePermissionMock = vi.fn();

vi.mock("../../captureApi", () => ({
  getScreenCapturePermission: () => getScreenCapturePermissionMock(),
}));

vi.mock("../../modeApi", () => ({
  setLightingMode: (payload: unknown) => setLightingModeMock(payload),
  stopLighting: () => stopLightingMock(),
  stopHue: (...args: unknown[]) => stopHueMock(...args),
  startHue: (payload: unknown) => startHueMock(payload),
  setHueSolidColor: (payload: unknown) => setHueSolidColorMock(payload),
}));

vi.mock("@/features/shell/windowLifecycle", () => ({
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
  loadShellState: () => loadShellStateMock(),
}));

function harness(overrides: Partial<LightingModeOrchestratorInput> = {}) {
  const runtimeConfig = {
    hydrate: (mode: unknown) => mode,
    prime: vi.fn(),
    setCalibration: vi.fn(),
    setAmbilight: vi.fn(),
    setLightingSmoothingPreset: vi.fn(),
    setColorCorrection: vi.fn(),
    setFirmwareProfile: vi.fn(),
    getSelectedDisplayId: () => undefined,
  } as unknown as LightingModeOrchestratorInput["runtimeConfig"];

  const input: LightingModeOrchestratorInput = {
    runtimeConfig,
    savedCalibration: undefined,
    hueStartConfig: null,
    setHueStartConfig: vi.fn(),
    onRequireCalibration: vi.fn(),
    reportHueSolidColorStatus: vi.fn(),
    ...overrides,
  };

  return renderHook(() => useLightingModeOrchestrator(input));
}

describe("useLightingModeOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
      Promise.resolve(appliedResult(payload)),
    );
    stopLightingMock.mockResolvedValue({ active: false });
    stopHueMock.mockResolvedValue({
      active: false,
      status: { code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    });
    saveShellStateMock.mockResolvedValue(undefined);
    loadShellStateMock.mockResolvedValue({});
    getScreenCapturePermissionMock.mockResolvedValue({
      code: "SCREEN_CAPTURE_PERMISSION_GRANTED",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts OFF on the default target set", () => {
    const { result } = harness();
    expect(result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
    expect(result.current.selectedOutputTargets).toEqual(["usb"]);
    expect(result.current.activeOutputTargets).toEqual([]);
    expect(result.current.stopFailedNotice).toBeNull();
  });

  it("persists the target selection even while nothing is running (INV-17)", async () => {
    const { result } = harness();

    await act(async () => {
      await result.current.handleOutputTargetsChange(["hue"]);
    });

    expect(saveShellStateMock).toHaveBeenCalledWith({ lastOutputTargets: ["hue"] });
    // Mode is OFF, so no delta command may be issued.
    expect(stopLightingMock).not.toHaveBeenCalled();
    expect(startHueMock).not.toHaveBeenCalled();
  });

  describe("delta-stop outcomes (INV-18)", () => {
    async function runFailingDeltaStop() {
      const view = harness();
      // Put the orchestrator into a running USB+Hue session.
      act(() => {
        view.result.current.setLightingMode({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: { r: 1, g: 2, b: 3, brightness: 1 },
        });
        view.result.current.setSelectedOutputTargets(["usb", "hue"]);
        view.result.current.setActiveOutputTargets(["usb", "hue"]);
      });

      stopLightingMock.mockRejectedValue(new Error("port gone"));
      await act(async () => {
        await view.result.current.handleOutputTargetsChange(["hue"]);
      });
      return view;
    }

    it("retains a target whose stop rejected and raises the notice", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const view = await runFailingDeltaStop();

      expect(view.result.current.stopFailedNotice).toEqual(["usb"]);
      // The chip stays truthful: a failed stop keeps the target active.
      expect(view.result.current.activeOutputTargets).toContain("usb");
      errorSpy.mockRestore();
    });

    it("auto-dismisses the notice after 5 s", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const view = await runFailingDeltaStop();
      expect(view.result.current.stopFailedNotice).toEqual(["usb"]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(view.result.current.stopFailedNotice).toBeNull();
      errorSpy.mockRestore();
    });

    it("leaves no dismissal timer behind when unmounted mid-notice", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const view = await runFailingDeltaStop();
      expect(view.result.current.stopFailedNotice).toEqual(["usb"]);

      const pendingBefore = vi.getTimerCount();
      expect(pendingBefore).toBeGreaterThan(0);
      view.unmount();
      // The untracked window.setTimeout this replaced survived unmount and
      // fired later against a dead setter.
      expect(vi.getTimerCount()).toBeLessThan(pendingBefore);
      errorSpy.mockRestore();
    });

    it("drops a target whose stop succeeded", async () => {
      const view = harness();
      act(() => {
        view.result.current.setLightingMode({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: { r: 1, g: 2, b: 3, brightness: 1 },
        });
        view.result.current.setSelectedOutputTargets(["usb", "hue"]);
        view.result.current.setActiveOutputTargets(["usb", "hue"]);
      });

      await act(async () => {
        await view.result.current.handleOutputTargetsChange(["hue"]);
      });

      expect(stopLightingMock).toHaveBeenCalledOnce();
      expect(view.result.current.activeOutputTargets).not.toContain("usb");
      expect(view.result.current.stopFailedNotice).toBeNull();
    });
  });

  it("keeps lastNonOffMode pointing at the last real mode (INV-25)", async () => {
    const { result } = harness();

    act(() => {
      result.current.setLightingMode({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
    });
    await waitFor(() => expect(result.current.lastNonOffModeRef.current?.kind).toBe("ambilight"));

    act(() => {
      result.current.setLightingMode({ kind: LIGHTING_MODE_KIND.OFF });
    });
    await waitFor(() => expect(result.current.lightingMode.kind).toBe("off"));
    // The tray "Resume last mode" item reads this — OFF must not overwrite it.
    expect(result.current.lastNonOffModeRef.current?.kind).toBe("ambilight");
  });

  it("routes the OFF transition to stopLighting and clears active targets", async () => {
    const { result } = harness();
    act(() => {
      result.current.setLightingMode({
        kind: LIGHTING_MODE_KIND.SOLID,
        solid: { r: 1, g: 2, b: 3, brightness: 1 },
      });
      result.current.setActiveOutputTargets(["usb"]);
    });

    await act(async () => {
      await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.OFF });
    });

    expect(stopLightingMock).toHaveBeenCalledOnce();
    expect(result.current.lightingMode.kind).toBe("off");
    expect(result.current.isModeTransitioning).toBe(false);
  });

  describe("capture start failures", () => {
    // D-05 gates a USB target with no calibration before Phase 2 ever runs.
    const savedCalibration = {
      totalLeds: 60,
    } as unknown as LightingModeOrchestratorInput["savedCalibration"];

    function startFailedResult(details: string | null) {
      return {
        active: false,
        mode: { kind: LIGHTING_MODE_KIND.OFF },
        status: {
          code: "AMBILIGHT_MODE_START_FAILED",
          message: "Ambilight runtime could not start.",
          details,
        },
      };
    }

    it("classifies a screen-recording denial into the permission bucket", async () => {
      setLightingModeMock.mockResolvedValue(
        startFailedResult("AMBILIGHT_CAPTURE_PERMISSION_DENIED"),
      );
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice).toEqual({
        bucket: "permission",
        reason: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
      });
    });

    it("distinguishes a missing display from a denial — the whole point of the union", async () => {
      setLightingModeMock.mockResolvedValue(
        startFailedResult("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"),
      );
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice?.bucket).toBe("display");
    });

    it("keeps an unknown reason visible instead of dropping it", async () => {
      setLightingModeMock.mockResolvedValue(startFailedResult("AMBILIGHT_CAPTURE_NOT_YET_INVENTED"));
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice).toEqual({
        bucket: "internal",
        reason: "AMBILIGHT_CAPTURE_NOT_YET_INVENTED",
      });
    });

    it("does not commit or persist a mode the backend refused to start", async () => {
      setLightingModeMock.mockResolvedValue(
        startFailedResult("AMBILIGHT_CAPTURE_PERMISSION_DENIED"),
      );
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      // Showing ON here also persisted the mode, so the next launch restored a
      // mode that had never run.
      expect(result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
      expect(result.current.activeOutputTargets).not.toContain("usb");
    });

    it("does not commit when a gate refuses while another kind is still live", async () => {
      // The gate arms return `owner.active_mode` — the RUNNING mode — so `active`
      // is true here and only the kind mismatch exposes the refusal.
      setLightingModeMock.mockResolvedValue({
        active: true,
        mode: { kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 1, g: 2, b: 3, brightness: 1 } },
        status: {
          code: "DEVICE_NOT_CONNECTED",
          message: "Cannot apply lighting mode while device is disconnected.",
          details: null,
        },
      });
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.lightingMode.kind).not.toBe(LIGHTING_MODE_KIND.AMBILIGHT);
      expect(result.current.activeOutputTargets).not.toContain("usb");
    });

    it("commits the mode when the backend accepts it", async () => {
      setLightingModeMock.mockResolvedValue({
        active: true,
        mode: { kind: LIGHTING_MODE_KIND.AMBILIGHT },
        status: { code: "AMBILIGHT_MODE_STARTED", message: "Started.", details: null },
      });
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.AMBILIGHT);
      expect(result.current.activeOutputTargets).toContain("usb");
    });

    it("stays silent when the start succeeds", async () => {
      setLightingModeMock.mockResolvedValue({
        active: true,
        mode: { kind: LIGHTING_MODE_KIND.AMBILIGHT },
        status: { code: "AMBILIGHT_MODE_STARTED", message: "Started.", details: null },
      });
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice).toBeNull();
    });

    it("does not toast for a bare dispatch — only a user transition raises it", async () => {
      setLightingModeMock.mockResolvedValue(
        startFailedResult("AMBILIGHT_CAPTURE_PERMISSION_DENIED"),
      );
      const { result } = harness({ savedCalibration });

      // The hot-reload / bootstrap-shaped path. `useShellBootstrap` goes further
      // still and calls `modeApi.setLightingMode` without touching this hook.
      await act(async () => {
        await result.current.dispatch({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(setLightingModeMock).toHaveBeenCalled();
      expect(result.current.startFailedNotice).toBeNull();
    });

    it("auto-dismisses after 8 s", async () => {
      vi.useFakeTimers();
      setLightingModeMock.mockResolvedValue(
        startFailedResult("AMBILIGHT_CAPTURE_PERMISSION_DENIED"),
      );
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });
      expect(result.current.startFailedNotice).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(result.current.startFailedNotice).toBeNull();
    });
  });

  describe("screen-recording preflight", () => {
    const savedCalibration = {
      totalLeds: 60,
    } as unknown as LightingModeOrchestratorInput["savedCalibration"];

    it("raises the permission notice before the start is attempted", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({
        code: "SCREEN_CAPTURE_PERMISSION_DENIED",
      });
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice).toEqual({
        bucket: "permission",
        reason: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
      });
    });

    it("still dispatches the start when denied — the OS prompt only fires there", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({
        code: "SCREEN_CAPTURE_PERMISSION_DENIED",
      });
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(setLightingModeMock).toHaveBeenCalled();
    });

    it("stays silent on a platform with no consent gate", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({
        code: "SCREEN_CAPTURE_PERMISSION_NOT_REQUIRED",
      });
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice).toBeNull();
    });

    it("does not probe for a Solid transition — nothing captures the screen", async () => {
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: { r: 1, g: 2, b: 3, brightness: 1 },
        });
      });

      expect(getScreenCapturePermissionMock).not.toHaveBeenCalled();
    });
  });

  it("routes a USB target with no calibration to the editor instead of dispatching (D-05)", async () => {
    const onRequireCalibration = vi.fn();
    const { result } = harness({ onRequireCalibration, savedCalibration: undefined });

    await act(async () => {
      await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
    });

    expect(onRequireCalibration).toHaveBeenCalledOnce();
    expect(setLightingModeMock).not.toHaveBeenCalled();
    // The lock must be released, or every later toggle is dead.
    expect(result.current.isModeTransitioning).toBe(false);
  });
});
