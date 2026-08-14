import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LED_CHIP_TYPE } from "@/shared/contracts/device";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../../model/contracts";
import type { LightingModeDispatcher } from "../useLightingModeDispatch";
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
});
