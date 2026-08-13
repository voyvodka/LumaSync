import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND } from "../../model/contracts";
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
    setLightingModeMock.mockResolvedValue({ active: true });
    stopLightingMock.mockResolvedValue({ active: false });
    stopHueMock.mockResolvedValue({
      active: false,
      status: { code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    });
    saveShellStateMock.mockResolvedValue(undefined);
    loadShellStateMock.mockResolvedValue({});
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
