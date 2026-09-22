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

  describe("OFF-path stop outcomes", () => {
    async function runOffWithFailingUsbStop() {
      const view = harness();
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
        await view.result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.OFF });
      });
      return view;
    }

    it("still asks the other target to stop", async () => {
      await runOffWithFailingUsbStop();
      expect(stopHueMock).toHaveBeenCalled();
    });

    it("drops the target that stopped and keeps the one that did not", async () => {
      const view = await runOffWithFailingUsbStop();

      // Under `Promise.all` the USB rejection aborted before the results were
      // applied, so both stayed active — including the one already stopped.
      expect(view.result.current.activeOutputTargets).not.toContain("hue");
      expect(view.result.current.activeOutputTargets).toContain("usb");
    });

    it("reaches OFF, rather than leaving the toggle on the mode it just stopped", async () => {
      const view = await runOffWithFailingUsbStop();

      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
      expect(view.result.current.isModeTransitioning).toBe(false);
    });
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

  // The merge a partial mode change goes through. A retired helper that did the
  // same merge for persistence dropped `targets`; this is the one that ships.
  it("fills omitted payloads from the current mode and carries the selected targets", async () => {
    const solid = { r: 10, g: 20, b: 30, brightness: 0.5 };
    const ambilight = { brightness: 0.7 };
    setHueSolidColorMock.mockResolvedValue({
      status: { code: "HUE_SOLID_COLOR_APPLIED", message: "", details: null },
    });
    const { result } = harness();
    act(() => {
      result.current.setLightingMode({ kind: LIGHTING_MODE_KIND.SOLID, solid, ambilight });
      result.current.setSelectedOutputTargets(["usb", "hue"]);
      result.current.setActiveOutputTargets(["usb"]);
    });

    await act(async () => {
      await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.SOLID });
    });

    const dispatched = setLightingModeMock.mock.lastCall?.[0] as LightingModeConfig;
    expect(dispatched.solid).toEqual(solid);
    expect(dispatched.ambilight?.brightness).toBe(0.7);
    expect(dispatched.targets).toEqual(["usb", "hue"]);

    await waitFor(() =>
      expect(saveShellStateMock).toHaveBeenCalledWith({
        lightingMode: expect.objectContaining({ solid, targets: ["usb", "hue"] }),
      }),
    );
  });

  // The bridge admits one entertainment streamer, so a refused apply that
  // leaves a stream open with nothing feeding it locks every other client out.
  describe("Hue stream after a refused apply", () => {
    const hueStartConfig = {
      bridgeIp: "192.168.1.50",
      username: "app-key",
      clientKey: "client-key",
      areaId: "area-1",
    };
    const solid = { r: 1, g: 2, b: 3, brightness: 1 };

    function startedHue(code = "HUE_STREAM_RUNNING_DTLS") {
      return {
        active: true,
        status: { code, message: "ok", details: null, state: "Running" },
      };
    }

    function captureStartFailed() {
      return {
        active: false,
        mode: { kind: LIGHTING_MODE_KIND.OFF },
        status: {
          code: "AMBILIGHT_MODE_START_FAILED",
          message: "failed",
          details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
        },
      };
    }

    function hueOnly(opts: { running?: boolean } = {}) {
      const view = harness({ hueStartConfig });
      act(() => {
        view.result.current.setSelectedOutputTargets(["hue"]);
        if (opts.running) {
          view.result.current.setLightingMode({ kind: LIGHTING_MODE_KIND.SOLID, solid });
          view.result.current.setActiveOutputTargets(["hue"]);
        }
      });
      return view;
    }

    it("releases a stream this apply opened when the mode never ran", async () => {
      startHueMock.mockResolvedValue(startedHue());
      setLightingModeMock.mockResolvedValue(captureStartFailed());
      const { result } = hueOnly();

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(stopHueMock).toHaveBeenCalledWith("system");
      expect(result.current.activeOutputTargets).toEqual([]);
      expect(result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
    });

    it("keeps the stream a still-running mode is using when a gate refuses", async () => {
      startHueMock.mockResolvedValue(startedHue("HUE_START_NOOP_ALREADY_ACTIVE"));
      setLightingModeMock.mockResolvedValue({
        active: true,
        mode: { kind: LIGHTING_MODE_KIND.SOLID, solid, targets: ["hue"] },
        status: { code: "DEVICE_NOT_CONNECTED", message: "gated", details: null },
      });
      const { result } = hueOnly({ running: true });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(stopHueMock).not.toHaveBeenCalled();
      expect(result.current.activeOutputTargets).toEqual(["hue"]);
      expect(result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.SOLID);
    });

    it("releases the previous mode's stream once the backend has torn that mode down", async () => {
      startHueMock.mockResolvedValue(startedHue("HUE_START_NOOP_ALREADY_ACTIVE"));
      setLightingModeMock.mockResolvedValue(captureStartFailed());
      const { result } = hueOnly({ running: true });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(stopHueMock).toHaveBeenCalledWith("system");
      expect(result.current.activeOutputTargets).toEqual([]);
      // Solid was stopped by the backend before the capture failed.
      expect(result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
    });

    it("leaves a stream it never held alone", async () => {
      // A no-op start with "hue" not active: another owner (a test lease) holds it.
      startHueMock.mockResolvedValue(startedHue("HUE_START_NOOP_ALREADY_ACTIVE"));
      setLightingModeMock.mockResolvedValue(captureStartFailed());
      const { result } = hueOnly();

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(stopHueMock).not.toHaveBeenCalled();
    });

    it("keeps hue listed and raises the stop notice when the release fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      startHueMock.mockResolvedValue(startedHue());
      setLightingModeMock.mockResolvedValue(captureStartFailed());
      stopHueMock.mockRejectedValue(new Error("bridge gone"));
      const { result } = hueOnly();

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.activeOutputTargets).toEqual(["hue"]);
      expect(result.current.stopFailedNotice).toEqual(["hue"]);
      errorSpy.mockRestore();
    });

    it("does not stop anything when the apply is accepted", async () => {
      startHueMock.mockResolvedValue(startedHue());
      const { result } = hueOnly();

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(stopHueMock).not.toHaveBeenCalled();
      expect(result.current.activeOutputTargets).toEqual(["hue"]);
    });
  });

  // Maintainer decision: a [usb, hue] start the Hue gate refuses runs on USB
  // alone for the session, with a notice, and never rewrites lastOutputTargets.
  describe("Hue left out of a [usb, hue] start", () => {
    const hueStartConfig = {
      bridgeIp: "192.168.1.50",
      username: "app-key",
      clientKey: "client-key",
      areaId: "area-1",
    };
    const savedCalibration = {
      totalLeds: 60,
    } as unknown as LightingModeOrchestratorInput["savedCalibration"];

    function hueStart(code: string, state = "Idle") {
      return { active: false, status: { code, message: "hue", details: null, state } };
    }

    // What `apply_mode_change` answers: the Hue gate refuses any request naming
    // "hue" while `hue_output` is None, reporting the running mode.
    function gateOnHue(running: LightingModeConfig = { kind: LIGHTING_MODE_KIND.OFF }) {
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
        Promise.resolve(
          (payload.targets ?? []).includes("hue")
            ? {
                active: running.kind !== LIGHTING_MODE_KIND.OFF,
                mode: running,
                status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
              }
            : appliedResult(payload),
        ),
      );
    }

    function usbAndHue(config: typeof hueStartConfig | null = hueStartConfig) {
      const view = harness({ hueStartConfig: config, savedCalibration });
      act(() => {
        view.result.current.setSelectedOutputTargets(["usb", "hue"]);
      });
      return view;
    }

    async function switchTo(view: ReturnType<typeof usbAndHue>, kind: LightingModeConfig["kind"]) {
      await act(async () => {
        await view.result.current.handleLightingModeChange({ kind });
      });
    }

    it("re-dispatches once on USB alone and runs the mode", async () => {
      startHueMock.mockResolvedValue(
        hueStart("CONFIG_NOT_READY_GATE_BLOCKED"),
      );
      gateOnHue();
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);

      expect(setLightingModeMock).toHaveBeenCalledTimes(2);
      expect(setLightingModeMock.mock.calls[0][0].targets).toEqual(["usb", "hue"]);
      expect(setLightingModeMock.mock.calls[1][0].targets).toEqual(["usb"]);
      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.AMBILIGHT);
      // The live mode carries what ran, so a hot-reload re-dispatch passes the gate.
      expect(view.result.current.lightingMode.targets).toEqual(["usb"]);
      expect(view.result.current.activeOutputTargets).toEqual(["usb"]);
      expect(view.result.current.selectedOutputTargets).toEqual(["usb"]);
      expect(view.result.current.hueLeftOutNotice).toBe("unreachable");
      // An Idle, gate-blocked start has nothing retrying — nothing to cancel.
      expect(stopHueMock).not.toHaveBeenCalled();
    });

    it("never persists the reduced target set", async () => {
      startHueMock.mockResolvedValue(hueStart("CONFIG_NOT_READY_GATE_BLOCKED"));
      gateOnHue();
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);
      // Flushes the debounced lightingMode write.
      view.unmount();

      const patches = saveShellStateMock.mock.calls.map(([patch]) => patch as Record<string, unknown>);
      expect(patches.some((patch) => "lastOutputTargets" in patch)).toBe(false);
      const persistedMode = patches.find((patch) => "lightingMode" in patch)?.lightingMode as
        | LightingModeConfig
        | undefined;
      expect(persistedMode?.kind).toBe(LIGHTING_MODE_KIND.AMBILIGHT);
      expect(persistedMode?.targets).toEqual(["usb", "hue"]);
    });

    it("cancels a start that left Hue retrying before running on USB", async () => {
      startHueMock.mockResolvedValue(hueStart("TRANSIENT_RETRY_SCHEDULED", "Reconnecting"));
      gateOnHue();
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);

      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(stopHueMock).toHaveBeenCalledWith("system");
      expect(stopHueMock.mock.invocationCallOrder[0]).toBeLessThan(
        setLightingModeMock.mock.invocationCallOrder[1],
      );
      expect(view.result.current.activeOutputTargets).toEqual(["usb"]);
      expect(view.result.current.hueLeftOutNotice).toBe("unreachable");
    });

    it("keeps hue listed and raises the stop notice when the cancel does not confirm", async () => {
      startHueMock.mockResolvedValue(hueStart("TRANSIENT_RETRY_SCHEDULED", "Reconnecting"));
      stopHueMock.mockResolvedValue({ active: true, status: { code: "HUE_STOP_TIMEOUT_PARTIAL" } });
      gateOnHue();
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);

      expect(view.result.current.activeOutputTargets).toEqual(["usb", "hue"]);
      expect(view.result.current.stopFailedNotice).toEqual(["hue"]);
    });

    it("names a re-pair for an auth-invalid start", async () => {
      startHueMock.mockResolvedValue(hueStart("AUTH_INVALID_CREDENTIALS", "Failed"));
      gateOnHue();
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.SOLID);

      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.SOLID);
      expect(view.result.current.hueLeftOutNotice).toBe("auth");
      expect(setHueSolidColorMock).not.toHaveBeenCalled();
    });

    it("says Hue is not set up when there is no start config", async () => {
      gateOnHue();
      const view = usbAndHue(null);

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);

      expect(startHueMock).not.toHaveBeenCalled();
      expect(view.result.current.hueLeftOutNotice).toBe("config");
    });

    it("raises no notice and keeps the selection when the USB retry is refused too", async () => {
      startHueMock.mockResolvedValue(hueStart("CONFIG_NOT_READY_GATE_BLOCKED"));
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
        Promise.resolve(
          (payload.targets ?? []).includes("hue")
            ? {
                active: false,
                mode: { kind: LIGHTING_MODE_KIND.OFF },
                status: { code: "HUE_NOT_READY", message: "not ready", details: null },
              }
            : {
                active: false,
                mode: { kind: LIGHTING_MODE_KIND.OFF },
                status: {
                  code: "AMBILIGHT_MODE_START_FAILED",
                  message: "failed",
                  details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
                },
              },
        ),
      );
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);

      expect(setLightingModeMock).toHaveBeenCalledTimes(2);
      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
      expect(view.result.current.hueLeftOutNotice).toBeNull();
      expect(view.result.current.selectedOutputTargets).toEqual(["usb", "hue"]);
      expect(view.result.current.startFailedNotice?.bucket).toBe("permission");
    });

    it("does not retry a Hue-only start the gate refuses", async () => {
      startHueMock.mockResolvedValue(hueStart("CONFIG_NOT_READY_GATE_BLOCKED"));
      gateOnHue();
      const view = harness({ hueStartConfig, savedCalibration });
      act(() => {
        view.result.current.setSelectedOutputTargets(["hue"]);
      });

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);

      expect(setLightingModeMock).toHaveBeenCalledTimes(1);
      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
      expect(view.result.current.hueLeftOutNotice).toBeNull();
    });

    it("auto-dismisses the notice after 8 s", async () => {
      vi.useFakeTimers();
      startHueMock.mockResolvedValue(hueStart("CONFIG_NOT_READY_GATE_BLOCKED"));
      gateOnHue();
      const view = usbAndHue();

      await switchTo(view, LIGHTING_MODE_KIND.AMBILIGHT);
      expect(view.result.current.hueLeftOutNotice).toBe("unreachable");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(view.result.current.hueLeftOutNotice).toBeNull();
    });
  });

  // The same rule as a [usb, hue] start, reached by adding Hue to a running
  // USB mode: "hue" goes active only once the backend runs it.
  describe("Hue added to a running USB mode", () => {
    const hueStartConfig = {
      bridgeIp: "192.168.1.50",
      username: "app-key",
      clientKey: "client-key",
      areaId: "area-1",
    };
    const running: LightingModeConfig = { kind: LIGHTING_MODE_KIND.AMBILIGHT, targets: ["usb"] };

    function hueStart(code: string, state = "Idle") {
      return { active: false, status: { code, message: "hue", details: null, state } };
    }

    function gateOnHue() {
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
        Promise.resolve(
          (payload.targets ?? []).includes("hue")
            ? {
                active: true,
                mode: running,
                status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
              }
            : appliedResult(payload),
        ),
      );
    }

    async function addHue(config: typeof hueStartConfig | null = hueStartConfig) {
      const view = harness({ hueStartConfig: config });
      act(() => {
        view.result.current.setLightingMode(running);
        view.result.current.setSelectedOutputTargets(["usb"]);
        view.result.current.setActiveOutputTargets(["usb"]);
      });
      await act(async () => {
        await view.result.current.handleOutputTargetsChange(["usb", "hue"]);
      });
      return view;
    }

    it("keeps Hue out of the active set when the gate refuses the re-apply", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      startHueMock.mockResolvedValue(hueStart("HUE_STREAM_RUNNING_DTLS", "Running"));
      gateOnHue();

      const view = await addHue();

      expect(setLightingModeMock).toHaveBeenCalledTimes(1);
      expect(setLightingModeMock.mock.calls[0][0].targets).toEqual(["usb", "hue"]);
      expect(view.result.current.activeOutputTargets).toEqual(["usb"]);
      expect(view.result.current.hueLeftOutNotice).toBe("unreachable");
      // The gate returns before teardown: USB is neither stopped nor restarted.
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.AMBILIGHT);
      // The stream this add opened feeds nothing, so it is given back.
      expect(stopHueMock).toHaveBeenCalledWith("system");
      expect(view.result.current.selectedOutputTargets).toEqual(["usb"]);
      // The explicit add stays persisted; nothing rewrites it without Hue.
      const targetWrites = saveShellStateMock.mock.calls
        .map(([patch]) => patch as Record<string, unknown>)
        .filter((patch) => "lastOutputTargets" in patch);
      expect(targetWrites).toEqual([{ lastOutputTargets: ["usb", "hue"] }]);
      errorSpy.mockRestore();
    });

    it("cancels a start that left Hue retrying and does not re-apply", async () => {
      startHueMock.mockResolvedValue(hueStart("TRANSIENT_RETRY_SCHEDULED", "Reconnecting"));
      gateOnHue();

      const view = await addHue();

      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(stopHueMock).toHaveBeenCalledWith("system");
      expect(setLightingModeMock).not.toHaveBeenCalled();
      expect(view.result.current.activeOutputTargets).toEqual(["usb"]);
      expect(view.result.current.hueLeftOutNotice).toBe("unreachable");
    });

    it("keeps hue listed and raises the stop notice when the cancel does not confirm", async () => {
      startHueMock.mockResolvedValue(hueStart("TRANSIENT_RETRY_SCHEDULED", "Reconnecting"));
      stopHueMock.mockResolvedValue({ active: true, status: { code: "HUE_STOP_TIMEOUT_PARTIAL" } });

      const view = await addHue();

      expect(view.result.current.activeOutputTargets).toEqual(["usb", "hue"]);
      expect(view.result.current.stopFailedNotice).toEqual(["hue"]);
    });

    it("names a re-pair for an auth-invalid start", async () => {
      startHueMock.mockResolvedValue(hueStart("AUTH_INVALID_CREDENTIALS", "Failed"));

      const view = await addHue();

      expect(stopHueMock).not.toHaveBeenCalled();
      expect(view.result.current.hueLeftOutNotice).toBe("auth");
      expect(view.result.current.activeOutputTargets).toEqual(["usb"]);
    });

    it("says Hue is not set up when there is no start config", async () => {
      const view = await addHue(null);

      expect(startHueMock).not.toHaveBeenCalled();
      expect(view.result.current.hueLeftOutNotice).toBe("config");
      expect(view.result.current.selectedOutputTargets).toEqual(["usb"]);
    });

    it("shows Off, not USB, when the re-apply tore the running mode down", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      startHueMock.mockResolvedValue(hueStart("HUE_STREAM_RUNNING_DTLS", "Running"));
      setLightingModeMock.mockResolvedValue({
        active: false,
        mode: { kind: LIGHTING_MODE_KIND.OFF },
        status: {
          code: "AMBILIGHT_MODE_START_FAILED",
          message: "failed",
          details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
        },
      });

      const view = await addHue();

      expect(view.result.current.activeOutputTargets).toEqual([]);
      expect(view.result.current.lightingMode.kind).toBe(LIGHTING_MODE_KIND.OFF);
      expect(view.result.current.hueLeftOutNotice).toBeNull();
      expect(view.result.current.startFailedNotice?.bucket).toBe("permission");
      expect(stopHueMock).toHaveBeenCalledWith("system");
      errorSpy.mockRestore();
    });

    it("adds Hue when the backend runs it", async () => {
      startHueMock.mockResolvedValue(hueStart("HUE_STREAM_RUNNING_DTLS", "Running"));

      const view = await addHue();

      expect(setLightingModeMock).toHaveBeenCalledTimes(1);
      expect(view.result.current.activeOutputTargets).toEqual(["usb", "hue"]);
      expect(view.result.current.selectedOutputTargets).toEqual(["usb", "hue"]);
      expect(view.result.current.hueLeftOutNotice).toBeNull();
      expect(stopHueMock).not.toHaveBeenCalled();
    });
  });

  describe("start notice precedence", () => {
    const savedCalibration = {
      totalLeds: 60,
    } as unknown as LightingModeOrchestratorInput["savedCalibration"];

    function startFailed(details: string) {
      return {
        active: false,
        mode: { kind: LIGHTING_MODE_KIND.OFF },
        status: { code: "AMBILIGHT_MODE_START_FAILED", message: "failed", details },
      };
    }

    it("keeps the permission notice over an unclassified backend reason", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({ code: "SCREEN_CAPTURE_PERMISSION_DENIED" });
      setLightingModeMock.mockResolvedValue(startFailed("SCStream error -3801"));
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice).toEqual({
        bucket: "permission",
        reason: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
      });
    });

    it("lets a backend reason that names a cause replace the probe's guess", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({ code: "SCREEN_CAPTURE_PERMISSION_DENIED" });
      setLightingModeMock.mockResolvedValue(startFailed("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));
      const { result } = harness({ savedCalibration });

      await act(async () => {
        await result.current.handleLightingModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
      });

      expect(result.current.startFailedNotice?.bucket).toBe("display");
    });
  });
});
