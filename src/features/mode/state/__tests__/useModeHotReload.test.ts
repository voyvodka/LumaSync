import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { LED_CHIP_TYPE } from "@/shared/contracts/device";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../../model/contracts";
import { useLightingModeDispatch, type LightingModeDispatcher } from "../useLightingModeDispatch";
import { useModeHotReload } from "../useModeHotReload";
import { useModeRuntimeConfig } from "../useModeRuntimeConfig";

const AMBILIGHT: LightingModeConfig = {
  kind: LIGHTING_MODE_KIND.AMBILIGHT,
  targets: ["usb"],
  ambilight: { brightness: 1 },
};

const OFF: LightingModeConfig = { kind: LIGHTING_MODE_KIND.OFF, targets: [] };

function setup(lightingMode: LightingModeConfig) {
  const dispatch = vi.fn<LightingModeDispatcher>().mockResolvedValue(null);
  const { result } = renderHook(() => {
    const runtimeConfig = useModeRuntimeConfig({ calibration: undefined });
    return { runtimeConfig, handlers: useModeHotReload(runtimeConfig, dispatch, lightingMode) };
  });
  return { dispatch, result };
}

describe("useModeHotReload", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("onChipTypeChange", () => {
    it("mirrors the chip type into the payload the next dispatch hydrates", () => {
      const { result } = setup(AMBILIGHT);

      act(() => result.current.handlers.onChipTypeChange(LED_CHIP_TYPE.SK6812_RGBW));

      expect(result.current.runtimeConfig.hydrate(AMBILIGHT).chipType).toBe(
        LED_CHIP_TYPE.SK6812_RGBW,
      );
    });

    it("forces the re-dispatch, because the signature can match while the bytes differ", () => {
      const { dispatch, result } = setup(AMBILIGHT);

      act(() => result.current.handlers.onChipTypeChange(LED_CHIP_TYPE.SK6812_RGBW));

      expect(dispatch).toHaveBeenCalledWith(AMBILIGHT, { force: true });
    });

    it("hot-reloads non-ambilight modes too — solid and off drive the same encoder", () => {
      const { dispatch, result } = setup(OFF);

      act(() => result.current.handlers.onChipTypeChange(LED_CHIP_TYPE.SK6812_RGBW));

      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe("onSelectedDisplayIdChange", () => {
    it("mirrors the display into the payload the next dispatch hydrates", () => {
      const { result } = setup(AMBILIGHT);

      act(() => result.current.handlers.onSelectedDisplayIdChange("display-2"));

      expect(result.current.runtimeConfig.hydrate(AMBILIGHT).displayId).toBe("display-2");
      expect(result.current.runtimeConfig.getSelectedDisplayId()).toBe("display-2");
    });

    it("re-dispatches so a running capture moves to the new monitor", () => {
      const { dispatch, result } = setup(AMBILIGHT);

      act(() => result.current.handlers.onSelectedDisplayIdChange("display-2"));

      expect(dispatch).toHaveBeenCalledWith(AMBILIGHT);
    });

    it("does not re-dispatch off, which binds no capture source", () => {
      const { dispatch, result } = setup(OFF);

      act(() => result.current.handlers.onSelectedDisplayIdChange("display-2"));

      expect(dispatch).not.toHaveBeenCalled();
      // The mirror still happens, so the next real dispatch carries it.
      expect(result.current.runtimeConfig.getSelectedDisplayId()).toBe("display-2");
    });
  });

  describe("onColorOrderChange", () => {
    it("re-dispatches without force — the order is in the signature and Rust retunes in place", () => {
      const { dispatch, result } = setup(AMBILIGHT);

      act(() => result.current.handlers.onColorOrderChange("grb"));

      expect(dispatch).toHaveBeenCalledWith(AMBILIGHT);
      expect(result.current.runtimeConfig.hydrate(AMBILIGHT).colorOrder).toBe("grb");
    });

    it("reaches set_lighting_mode carrying the new order through the real funnel", async () => {
      invokeMock.mockResolvedValue({ mode: AMBILIGHT, status: { code: "AMBILIGHT_MODE_UPDATED" } });
      const { result } = renderHook(() => {
        const runtimeConfig = useModeRuntimeConfig({ calibration: undefined });
        const { dispatch } = useLightingModeDispatch(runtimeConfig.hydrate);
        return useModeHotReload(runtimeConfig, dispatch, AMBILIGHT);
      });

      await act(async () => {
        result.current.onColorOrderChange("grb");
        await Promise.resolve();
      });

      expect(invokeMock).toHaveBeenCalledWith(
        "set_lighting_mode",
        expect.objectContaining({ payload: expect.objectContaining({ colorOrder: "grb" }) }),
      );
    });
  });

  describe("prime", () => {
    it("stamps the saved order, and the identity when none is saved", () => {
      const { result } = setup(AMBILIGHT);

      act(() => result.current.runtimeConfig.prime({ ledColorOrder: "bgr" }));
      expect(result.current.runtimeConfig.hydrate(OFF).colorOrder).toBe("bgr");

      act(() => result.current.runtimeConfig.prime({}));
      expect(result.current.runtimeConfig.hydrate(OFF).colorOrder).toBe("rgb");
    });
  });
});
