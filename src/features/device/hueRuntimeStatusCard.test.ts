import { describe, expect, it } from "vitest";

import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeStatus,
} from "../../shared/contracts/hue";
import { buildHueRuntimeStatusCard } from "./hueRuntimeStatusCard";

function createStatus(partial: Partial<HueRuntimeStatus>): HueRuntimeStatus {
  return {
    state: "Running",
    code: "HUE_STREAM_RUNNING",
    message: "Hue stream is active.",
    triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    ...partial,
  };
}

describe("buildHueRuntimeStatusCard", () => {
  it("shows retry progress cues while reconnecting", () => {
    const model = buildHueRuntimeStatusCard({
      status: createStatus({
        state: "Reconnecting",
        code: "TRANSIENT_RETRY_SCHEDULED",
        remainingAttempts: 2,
        nextAttemptMs: 1500,
        actionHint: HUE_RUNTIME_ACTION_HINT.RECONNECT,
      }),
    });

    expect(model.retry).toEqual({
      remainingAttempts: 2,
      nextAttemptMs: 1500,
      labelKey: "device.hue.runtime.retry.progress",
    });
    expect(model.actionHints).toEqual([HUE_RUNTIME_ACTION_HINT.RECONNECT]);
  });

  it("returns explicit re-pair action for AUTH_INVALID_* status families", () => {
    const model = buildHueRuntimeStatusCard({
      status: createStatus({
        state: "Failed",
        code: "AUTH_INVALID_CREDENTIALS",
        actionHint: undefined,
      }),
    });

    expect(model.actionHints).toContain(HUE_RUNTIME_ACTION_HINT.REPAIR);
  });

  it("returns revalidate and adjust-area actions for CONFIG_NOT_READY_* families", () => {
    const model = buildHueRuntimeStatusCard({
      status: createStatus({
        state: "Idle",
        code: "CONFIG_NOT_READY_GATE_BLOCKED",
        actionHint: undefined,
      }),
    });

    expect(model.actionHints).toEqual([
      HUE_RUNTIME_ACTION_HINT.REVALIDATE,
      HUE_RUNTIME_ACTION_HINT.ADJUST_AREA,
    ]);
  });

  it("keeps compact trigger-source hint in the status model", () => {
    const model = buildHueRuntimeStatusCard({
      status: createStatus({
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      }),
    });

    expect(model.triggerSourceKey).toBe("device.hue.runtime.triggerSource.device_surface");
  });

  it("does not crash when runtime status code is missing", () => {
    const model = buildHueRuntimeStatusCard({
      status: createStatus({
        code: undefined as unknown as string,
      }),
    });

    expect(model.actionHints).toEqual([]);
  });
});
