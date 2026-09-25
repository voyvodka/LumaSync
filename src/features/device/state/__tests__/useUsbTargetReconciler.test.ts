import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_ERROR_CODES } from "@/shared/contracts/device";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { connectionEvents } from "../../connectionEvents";
import {
  useUsbTargetReconciler,
  type UsbTargetReconcilerInput,
} from "../useUsbTargetReconciler";

function harness(overrides: Partial<UsbTargetReconcilerInput> = {}) {
  // Pairing and the unsupported-port fallback are both saved choices now: Rust
  // writes `lastOutputTargets` on arrival, so one callback serves both.
  const onSelectTargets = vi.fn().mockResolvedValue(undefined);
  const onAutoAddUsbTarget = onSelectTargets;
  const onFallbackTargets = onSelectTargets;
  const onDropUsbTarget = vi.fn().mockResolvedValue(undefined);
  const onLastTargetUnplugged = vi.fn().mockResolvedValue(true);
  const selectedOutputTargetsRef = createRef<HueRuntimeTarget[]>() as {
    current: HueRuntimeTarget[];
  };
  selectedOutputTargetsRef.current = overrides.selectedOutputTargets ?? ["usb"];
  const hueStartConfigRef = { current: null as unknown };

  const input: UsbTargetReconcilerInput = {
    isConnected: true,
    bootstrapDone: true,
    selectedOutputTargets: ["usb"],
    lightingRunning: true,
    selectedOutputTargetsRef,
    hueStartConfigRef,
    onSelectTargets,
    onDropUsbTarget,
    onLastTargetUnplugged,
    ...overrides,
  };

  const view = renderHook((props: UsbTargetReconcilerInput) => useUsbTargetReconciler(props), {
    initialProps: input,
  });

  return {
    view,
    input,
    onAutoAddUsbTarget,
    onDropUsbTarget,
    onLastTargetUnplugged: input.onLastTargetUnplugged as ReturnType<typeof vi.fn>,
    onFallbackTargets,
    hueStartConfigRef,
    selectedOutputTargetsRef,
  };
}

const unsupported = {
  portName: "/dev/cu.Bluetooth-Incoming-Port",
  connected: false,
  unsupportedReason: DEVICE_ERROR_CODES.PORT_UNSUPPORTED,
} as const;

describe("useUsbTargetReconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("hot-plug edge (INV-32, INV-34)", () => {
    it("stays inert until bootstrap arms the edge detector", () => {
      const { view, input, onAutoAddUsbTarget } = harness({
        bootstrapDone: false,
        isConnected: false,
        selectedOutputTargets: ["hue"],
      });
      view.rerender({ ...input, bootstrapDone: false, isConnected: true });
      expect(onAutoAddUsbTarget).not.toHaveBeenCalled();
    });

    it("does not fire a phantom edge on a cold start that boots connected", () => {
      const { view, input, onAutoAddUsbTarget } = harness({
        isConnected: true,
        selectedOutputTargets: ["hue"],
      });
      act(() => {
        view.result.current.armUsbConnected(true);
      });
      view.rerender({ ...input, selectedOutputTargets: ["hue"] });
      expect(onAutoAddUsbTarget).not.toHaveBeenCalled();
    });

    it("auto-adds usb on the false→true edge, bypassing the general handler", () => {
      const { view, input, onAutoAddUsbTarget, onDropUsbTarget } = harness({
        isConnected: false,
        selectedOutputTargets: ["hue"],
      });
      act(() => {
        view.result.current.armUsbConnected(false);
      });
      view.rerender({ ...input, isConnected: true, selectedOutputTargets: ["hue"] });

      expect(onAutoAddUsbTarget).toHaveBeenCalledWith(["usb", "hue"]);
      expect(onDropUsbTarget).not.toHaveBeenCalled();
    });

    it("does not re-add usb when it is already selected", () => {
      const { view, input, onAutoAddUsbTarget } = harness({
        isConnected: false,
        selectedOutputTargets: ["usb", "hue"],
      });
      act(() => {
        view.result.current.armUsbConnected(false);
      });
      view.rerender({ ...input, isConnected: true, selectedOutputTargets: ["usb", "hue"] });
      expect(onAutoAddUsbTarget).not.toHaveBeenCalled();
    });

    it("drops usb through the delta handler on unplug and raises the toast", () => {
      const { view, input, onDropUsbTarget } = harness({
        isConnected: true,
        selectedOutputTargets: ["usb", "hue"],
      });
      act(() => {
        view.result.current.armUsbConnected(true);
      });
      view.rerender({ ...input, isConnected: false, selectedOutputTargets: ["usb", "hue"] });

      expect(onDropUsbTarget).toHaveBeenCalledWith(["hue"]);
      expect(view.result.current.usbDisconnectNotice).toBe(true);
    });

    // "Continuing on the other outputs" with the mode Off named nothing that continued.
    it("drops usb on unplug without the toast while nothing runs", () => {
      const { view, input, onDropUsbTarget } = harness({
        isConnected: true,
        selectedOutputTargets: ["usb", "hue"],
        lightingRunning: false,
      });
      act(() => {
        view.result.current.armUsbConnected(true);
      });
      view.rerender({ ...input, isConnected: false, selectedOutputTargets: ["usb", "hue"] });

      expect(onDropUsbTarget).toHaveBeenCalledWith(["hue"]);
      expect(view.result.current.usbDisconnectNotice).toBe(false);
    });

    it("ends the mode instead of emptying the set when USB was the only target, and says so", async () => {
      const { view, input, onDropUsbTarget, onLastTargetUnplugged } = harness({
        isConnected: true,
        selectedOutputTargets: ["usb"],
      });
      act(() => {
        view.result.current.armUsbConnected(true);
      });
      await act(async () => {
        view.rerender({ ...input, isConnected: false, selectedOutputTargets: ["usb"] });
      });

      expect(onDropUsbTarget).not.toHaveBeenCalled();
      expect(onLastTargetUnplugged).toHaveBeenCalledTimes(1);
      expect(view.result.current.usbDisconnectLightingOffNotice).toBe(true);
      // "Continuing with remaining targets" would be false: there are none.
      expect(view.result.current.usbDisconnectNotice).toBe(false);
    });

    it("stays quiet when the unplug of the only target ended nothing", async () => {
      const { view, input, onLastTargetUnplugged } = harness({
        isConnected: true,
        selectedOutputTargets: ["usb"],
        onLastTargetUnplugged: vi.fn().mockResolvedValue(false),
      });
      act(() => {
        view.result.current.armUsbConnected(true);
      });
      await act(async () => {
        view.rerender({ ...input, isConnected: false, selectedOutputTargets: ["usb"] });
      });

      expect(onLastTargetUnplugged).toHaveBeenCalledTimes(1);
      expect(view.result.current.usbDisconnectLightingOffNotice).toBe(false);
      expect(view.result.current.usbDisconnectNotice).toBe(false);
    });

    it("auto-dismisses the disconnect toast and clears its timer on unmount", () => {
      vi.useFakeTimers();
      const { view, input } = harness({ isConnected: true, selectedOutputTargets: ["usb", "hue"] });
      act(() => {
        view.result.current.armUsbConnected(true);
      });
      view.rerender({ ...input, isConnected: false, selectedOutputTargets: ["usb", "hue"] });
      expect(view.result.current.usbDisconnectNotice).toBe(true);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(view.result.current.usbDisconnectNotice).toBe(false);

      const clearSpy = vi.spyOn(window, "clearTimeout");
      view.unmount();
      clearSpy.mockRestore();
    });
  });

  describe("boot-time unsupported-port fallback (INV-33)", () => {
    it("uses the raw filter so the dropped target is never re-added by the normalizer", () => {
      const { onFallbackTargets, selectedOutputTargetsRef } = harness();
      selectedOutputTargetsRef.current = ["usb"];

      act(() => {
        connectionEvents.emit(unsupported);
      });

      // normalizeOutputTargets([]) would have returned ["usb"] here.
      expect(onFallbackTargets).toHaveBeenCalledWith([]);
    });

    // No bridge is paired, so nothing took over: "switched to Hue-only" would be false.
    it("reports no fallback when Hue did not take over", () => {
      const { view, selectedOutputTargetsRef } = harness();
      selectedOutputTargetsRef.current = ["usb"];

      act(() => {
        connectionEvents.emit(unsupported);
      });
      expect(view.result.current.usbUnsupportedNotice).toBe(true);
      expect(view.result.current.usbUnsupportedHueFallback).toBe(false);
    });

    it("reports the Hue fallback when Hue is what is left", () => {
      const { view, selectedOutputTargetsRef } = harness();
      selectedOutputTargetsRef.current = ["usb", "hue"];

      act(() => {
        connectionEvents.emit(unsupported);
      });
      expect(view.result.current.usbUnsupportedHueFallback).toBe(true);
    });

    it("auto-adds hue when a bridge is paired so the user keeps an output sink", () => {
      const { view, onFallbackTargets, selectedOutputTargetsRef, hueStartConfigRef } = harness();
      selectedOutputTargetsRef.current = ["usb"];
      hueStartConfigRef.current = { bridgeIp: "192.168.1.10" };

      act(() => {
        connectionEvents.emit(unsupported);
      });
      expect(onFallbackTargets).toHaveBeenCalledWith(["hue"]);
      expect(view.result.current.usbUnsupportedHueFallback).toBe(true);
    });

    it("recovers a previously emptied target set when a bridge is paired", () => {
      const { onFallbackTargets, selectedOutputTargetsRef, hueStartConfigRef } = harness();
      selectedOutputTargetsRef.current = [];
      hueStartConfigRef.current = { bridgeIp: "192.168.1.10" };

      act(() => {
        connectionEvents.emit(unsupported);
      });
      expect(onFallbackTargets).toHaveBeenCalledWith(["hue"]);
    });

    it("does nothing when there is neither usb to drop nor hue to add", () => {
      const { onFallbackTargets, selectedOutputTargetsRef } = harness();
      selectedOutputTargetsRef.current = [];

      act(() => {
        connectionEvents.emit(unsupported);
      });
      expect(onFallbackTargets).not.toHaveBeenCalled();
    });

    it("ignores connected events and rejections without an unsupported reason", () => {
      const { onFallbackTargets } = harness();

      act(() => {
        connectionEvents.emit({ portName: "/dev/ttyUSB0", connected: true });
        connectionEvents.emit({ portName: "/dev/ttyUSB0", connected: false });
      });
      expect(onFallbackTargets).not.toHaveBeenCalled();
    });

    it("unsubscribes on unmount", () => {
      const { view, onFallbackTargets, selectedOutputTargetsRef } = harness();
      selectedOutputTargetsRef.current = ["usb"];
      view.unmount();

      act(() => {
        connectionEvents.emit(unsupported);
      });
      expect(onFallbackTargets).not.toHaveBeenCalled();
    });
  });
});
