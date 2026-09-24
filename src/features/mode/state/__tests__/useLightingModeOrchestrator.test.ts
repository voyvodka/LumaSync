import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AMBILIGHT_CAPTURE_REASON, CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";
import type {
  ApplyOutputsOutcome,
  ApplyOutputsResult,
  LightingRuntimeSnapshot,
} from "@/shared/contracts/lightingRuntime";
import type { LightingModeConfig } from "@/shared/contracts/mode";

const applyOutputsMock = vi.fn();
const retuneLightingMock = vi.fn();
const releaseHueOutputMock = vi.fn();
const getLightingRuntimeMock = vi.fn();
const getScreenCapturePermissionMock = vi.fn();
let pushSnapshot: ((snapshot: LightingRuntimeSnapshot) => void) | null = null;

vi.mock("../../modeApi", () => ({
  applyOutputs: (...args: unknown[]) => applyOutputsMock(...args),
  retuneLighting: (...args: unknown[]) => retuneLightingMock(...args),
  releaseHueOutput: (...args: unknown[]) => releaseHueOutputMock(...args),
  getLightingRuntime: () => getLightingRuntimeMock(),
}));

vi.mock("../../lightingRuntimeEventsApi", () => ({
  listenLightingRuntime: (cb: (snapshot: LightingRuntimeSnapshot) => void) => {
    pushSnapshot = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("../../captureApi", () => ({
  getScreenCapturePermission: () => getScreenCapturePermissionMock(),
}));

import { BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS, useLightingModeOrchestrator } from "../useLightingModeOrchestrator";

let revision = 0;

function snapshot(overrides: Partial<LightingRuntimeSnapshot> = {}): LightingRuntimeSnapshot {
  revision += 1;
  return {
    revision,
    mode: { kind: "off" },
    active: false,
    activeTargets: [],
    selectedTargets: ["usb"],
    phase: "idle",
    requestId: null,
    hueHeldOutReason: null,
    bootHueRetry: null,
    ...overrides,
  };
}

function reply(
  code: string,
  snap: LightingRuntimeSnapshot = snapshot(),
  outcome: Partial<ApplyOutputsOutcome> = {},
): ApplyOutputsResult {
  return {
    status: { code: code as ApplyOutputsResult["status"]["code"], message: "", details: null },
    requestId: 1,
    snapshot: snap,
    outcome: {
      hueStartCode: null,
      hueLeftOut: null,
      applyStatus: null,
      stopFailed: [],
      droppedTargets: [],
      modeEnded: false,
      ...outcome,
    },
  };
}

const running = (mode: LightingModeConfig, extra: Partial<LightingRuntimeSnapshot> = {}) =>
  snapshot({ mode, active: true, activeTargets: ["usb"], ...extra });

function mount() {
  const onRequireCalibration = vi.fn();
  const reportHueSolidColorStatus = vi.fn();
  const view = renderHook(() => useLightingModeOrchestrator({ onRequireCalibration, reportHueSolidColorStatus }));
  return { view, onRequireCalibration, reportHueSolidColorStatus };
}

async function settle(view: ReturnType<typeof mount>["view"]) {
  await waitFor(() => expect(pushSnapshot).not.toBeNull());
  await waitFor(() => expect(view.result.current).toBeDefined());
}

function publish(next: LightingRuntimeSnapshot) {
  act(() => {
    pushSnapshot?.(next);
  });
}

describe("useLightingModeOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushSnapshot = null;
    revision = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    getLightingRuntimeMock.mockResolvedValue(snapshot());
    applyOutputsMock.mockImplementation(() => Promise.resolve(reply("OUTPUTS_APPLIED")));
    retuneLightingMock.mockResolvedValue({ status: { code: "RETUNE_APPLIED", message: "", details: null } });
    releaseHueOutputMock.mockResolvedValue(reply("OUTPUTS_APPLIED"));
    getScreenCapturePermissionMock.mockResolvedValue({ code: "SCREEN_CAPTURE_PERMISSION_GRANTED" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the mirror", () => {
    it("shows what the snapshot says runs, and keeps the newest revision", async () => {
      const { view } = mount();
      await settle(view);

      publish(running({ kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 1 } }, { revision: 50 }));
      publish(snapshot({ revision: 49 }));

      expect(view.result.current.lightingMode.kind).toBe("solid");
      expect(view.result.current.activeOutputTargets).toEqual(["usb"]);
    });

    it("keeps the last colour through Off, so the controls still show it", async () => {
      const { view } = mount();
      await settle(view);

      publish(running({ kind: "solid", solid: { r: 9, g: 8, b: 7, brightness: 0.5 } }));
      publish(snapshot());

      expect(view.result.current.lightingMode.kind).toBe("off");
      expect(view.result.current.lightingMode.solid).toEqual({ r: 9, g: 8, b: 7, brightness: 0.5 });
    });
  });

  describe("choices", () => {
    it("sends a kind change as one apply_outputs with the kind and the given payload", async () => {
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "solid" }));

      expect(applyOutputsMock).toHaveBeenCalledTimes(1);
      expect(applyOutputsMock).toHaveBeenCalledWith({ mode: { kind: "solid" }, origin: "user" });
    });

    it("sends Off as a choice, whatever runs", async () => {
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "off" }));

      expect(applyOutputsMock).toHaveBeenCalledWith({ mode: { kind: "off" }, origin: "user" });
    });

    it("sends an output change as a saved choice, and an unplug as a session change", async () => {
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleOutputTargetsChange(["hue", "usb"]));
      await act(() => view.result.current.dropUnpluggedUsbTarget(["hue"]));

      expect(applyOutputsMock.mock.calls).toEqual([
        [{ targets: ["usb", "hue"], origin: "user" }],
        [{ targets: ["hue"], origin: "usbUnplug" }],
      ]);
    });

    it("reports whether an unplug of the only strip ended the mode", async () => {
      const { view } = mount();
      await settle(view);
      publish(running({ kind: "ambilight", ambilight: { brightness: 1 } }));
      applyOutputsMock.mockResolvedValue(reply("OUTPUTS_APPLIED", snapshot(), { modeEnded: true }));

      let ended = false;
      await act(async () => {
        ended = await view.result.current.endLightingOnUsbUnplug();
      });

      expect(ended).toBe(true);
      expect(applyOutputsMock).toHaveBeenCalledWith({ targets: [], origin: "usbUnplug" });
    });

    it("asks nothing for an unplug while Off", async () => {
      const { view } = mount();
      await settle(view);

      let ended = true;
      await act(async () => {
        ended = await view.result.current.endLightingOnUsbUnplug();
      });

      expect(ended).toBe(false);
      expect(applyOutputsMock).not.toHaveBeenCalled();
    });

    it("joins a second Hue release to the one in flight", async () => {
      let answer!: (value: ApplyOutputsResult) => void;
      releaseHueOutputMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const { view } = mount();
      await settle(view);

      const first = view.result.current.stopHueOutput("device_surface");
      const second = view.result.current.stopHueOutput("device_surface");
      await act(async () => {
        answer(reply("OUTPUTS_APPLIED"));
        await Promise.all([first, second]);
      });

      expect(releaseHueOutputMock).toHaveBeenCalledTimes(1);
      expect(releaseHueOutputMock).toHaveBeenCalledWith("device_surface");
    });

    it("sends the launch restore as a boot request with nothing else in it", async () => {
      const { view } = mount();
      await settle(view);

      await act(() =>
        view.result.current.restoreAtBoot({
          lightingMode: { kind: "off", ambilight: { brightness: 0.3 } },
        }),
      );

      expect(applyOutputsMock).toHaveBeenCalledWith({ origin: "boot" });
      expect(view.result.current.lightingMode.ambilight).toEqual({ brightness: 0.3 });
    });
  });

  /**
   * A setting change is one retune, never a storm. On hardware the old
   * orchestrator sent `set_lighting_mode` 68 times in a session, twenty of them
   * in one second, from drags and re-renders that each re-applied the mode.
   */
  describe("nudges within the running kind", () => {
    it("turn a drag into coalesced retunes and no apply at all", async () => {
      let answer!: () => void;
      retuneLightingMock.mockImplementationOnce(
        () => new Promise((resolve) => (answer = () => resolve({ status: { code: "RETUNE_APPLIED" } }))),
      );
      const { view } = mount();
      await settle(view);
      publish(running({ kind: "ambilight", ambilight: { brightness: 1 } }));

      for (let step = 1; step <= 20; step += 1) {
        void view.result.current.handleLightingModeChange({
          kind: "ambilight",
          ambilight: { brightness: step / 20 },
        });
      }
      expect(retuneLightingMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        answer();
      });

      await waitFor(() => expect(retuneLightingMock).toHaveBeenCalledTimes(2));
      expect(retuneLightingMock.mock.calls[1][0].ambilight.brightness).toBe(1);
      expect(applyOutputsMock).not.toHaveBeenCalled();
    });

    it("send nothing for a re-render that rebuilds the same payload", async () => {
      const { view } = mount();
      await settle(view);
      publish(running({ kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 1 } }));
      const same = { kind: "solid" as const, solid: { r: 1, g: 2, b: 3, brightness: 0.5 } };

      for (let i = 0; i < 10; i += 1) {
        await act(() => view.result.current.handleLightingModeChange({ ...same, solid: { ...same.solid } }));
      }

      expect(retuneLightingMock).toHaveBeenCalledTimes(1);
      expect(applyOutputsMock).not.toHaveBeenCalled();
    });

    it("retune the kind a choice in flight is bringing up, rather than choose it again", async () => {
      let answer!: (value: ApplyOutputsResult) => void;
      applyOutputsMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      const { view } = mount();
      await settle(view);

      const choice = view.result.current.handleLightingModeChange({ kind: "solid" });
      await act(async () => {
        await view.result.current.handleLightingModeChange({
          kind: "solid",
          solid: { r: 5, g: 5, b: 5, brightness: 1 },
        });
      });
      await act(async () => {
        answer(reply("OUTPUTS_APPLIED", running({ kind: "solid" })));
        await choice;
      });

      expect(applyOutputsMock).toHaveBeenCalledTimes(1);
      expect(retuneLightingMock).toHaveBeenCalledWith({ solid: { r: 5, g: 5, b: 5, brightness: 1 } });
    });
  });

  describe("notices", () => {
    it("routes a calibration refusal to the editor", async () => {
      applyOutputsMock.mockResolvedValue(reply("OUTPUTS_CALIBRATION_REQUIRED"));
      const { view, onRequireCalibration } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "ambilight" }));

      expect(onRequireCalibration).toHaveBeenCalledOnce();
    });

    it("raises the backend's start failure, but keeps the probe's permission notice over an unclassified one", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({ code: "SCREEN_CAPTURE_PERMISSION_DENIED" });
      applyOutputsMock.mockResolvedValue(
        reply("OUTPUTS_START_FAILED", snapshot(), {
          applyStatus: { code: "AMBILIGHT_MODE_START_FAILED", message: "", details: "something odd" },
        }),
      );
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "ambilight" }));

      expect(view.result.current.startFailedNotice?.bucket).toBe(CAPTURE_FAILURE_BUCKET.PERMISSION);
      expect(view.result.current.startFailedNotice?.reason).toBe(AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED);
    });

    it("clears a permission notice once a start goes through", async () => {
      getScreenCapturePermissionMock.mockResolvedValue({ code: "SCREEN_CAPTURE_PERMISSION_DENIED" });
      applyOutputsMock.mockResolvedValue(reply("OUTPUTS_APPLIED", running({ kind: "ambilight" })));
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "ambilight" }));

      expect(view.result.current.startFailedNotice).toBeNull();
    });

    it("stays quiet at launch about a display that is simply unplugged", async () => {
      applyOutputsMock.mockResolvedValue(
        reply("OUTPUTS_REFUSED", snapshot(), {
          applyStatus: {
            code: "AMBILIGHT_MODE_START_FAILED",
            message: "",
            details: AMBILIGHT_CAPTURE_REASON.MONITOR_NOT_FOUND,
          },
        }),
      );
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.restoreAtBoot({}));

      expect(view.result.current.startFailedNotice).toBeNull();
    });

    it("names the strip when a USB add was kept out by the device gate", async () => {
      applyOutputsMock.mockResolvedValue(
        reply("OUTPUTS_APPLIED_PARTIAL", running({ kind: "solid" }), {
          applyStatus: { code: "DEVICE_NOT_CONNECTED", message: "", details: null },
          droppedTargets: ["usb"],
        }),
      );
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleOutputTargetsChange(["usb", "hue"]));

      expect(view.result.current.startFailedNotice?.bucket).toBe(CAPTURE_FAILURE_BUCKET.OUTPUT);
    });

    it("keeps a stop that did not confirm on screen for a while", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      applyOutputsMock.mockResolvedValue(reply("OUTPUTS_APPLIED_PARTIAL", snapshot(), { stopFailed: ["hue"] }));
      const { view } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "off" }));
      expect(view.result.current.stopFailedNotice).toEqual(["hue"]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(view.result.current.stopFailedNotice).toBeNull();
    });

    it("follows the held-out reason: raised when it appears, gone when Hue joins", async () => {
      const { view } = mount();
      await settle(view);

      publish(running({ kind: "ambilight" }, { hueHeldOutReason: "unreachable" }));
      expect(view.result.current.hueLeftOutNotice).toBe("unreachable");
      expect(view.result.current.hueHeldOutReason).toBe("unreachable");

      publish(running({ kind: "ambilight" }, { activeTargets: ["usb", "hue"] }));
      expect(view.result.current.hueLeftOutNotice).toBeNull();
      expect(view.result.current.hueHeldOutReason).toBeNull();
    });

    it("keeps the busy notice up while the wait runs, and dismisses a gave-up one", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { view } = mount();
      await settle(view);

      publish(running({ kind: "ambilight" }, { hueHeldOutReason: "busy" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(view.result.current.hueLeftOutNotice).toBe("busy");

      publish(snapshot({ bootHueRetry: "gaveUp" }));
      expect(view.result.current.bootHueRetryNotice).toBe("gaveUp");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS);
      });
      expect(view.result.current.bootHueRetryNotice).toBeNull();
    });

    it("reports a Solid start whose Hue colour was skipped", async () => {
      applyOutputsMock.mockResolvedValue(
        reply("OUTPUTS_APPLIED", running({ kind: "solid" }), {
          applyStatus: {
            code: "SOLID_MODE_HUE_OUTPUT_SKIPPED",
            message: "",
            details: "HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS",
          },
        }),
      );
      const { view, reportHueSolidColorStatus } = mount();
      await settle(view);

      await act(() => view.result.current.handleLightingModeChange({ kind: "solid" }));

      expect(reportHueSolidColorStatus).toHaveBeenCalledWith("HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS");
    });
  });
});
