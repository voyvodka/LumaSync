import { describe, expect, it } from "vitest";

import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeStatus,
} from "../../shared/contracts/hue";
import { buildHueRuntimeStatusCard, deriveFamilyActionHints } from "./hueRuntimeStatusCard";

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

  it("produces variant: error when state is Failed with HUE-NET code", () => {
    const model = buildHueRuntimeStatusCard({
      status: createStatus({
        state: "Failed",
        code: "HUE-NET-01",
      }),
    });

    expect(model.variant).toBe("error");
    expect(model.actionHints).toEqual([HUE_RUNTIME_ACTION_HINT.RECONNECT]);
  });
});

describe("deriveFamilyActionHints", () => {
  describe("HUE-NET family (new)", () => {
    it("returns [RECONNECT] for HUE-NET-01", () => {
      expect(deriveFamilyActionHints("HUE-NET-01")).toEqual([HUE_RUNTIME_ACTION_HINT.RECONNECT]);
    });

    it("returns [RECONNECT] for HUE-NET-04", () => {
      expect(deriveFamilyActionHints("HUE-NET-04")).toEqual([HUE_RUNTIME_ACTION_HINT.RECONNECT]);
    });

    it("returns [RECONNECT] for any HUE-NET- prefix codes", () => {
      expect(deriveFamilyActionHints("HUE-NET-02")).toEqual([HUE_RUNTIME_ACTION_HINT.RECONNECT]);
      expect(deriveFamilyActionHints("HUE-NET-03")).toEqual([HUE_RUNTIME_ACTION_HINT.RECONNECT]);
    });
  });

  describe("HUE-AUTH family (new)", () => {
    it("returns [REPAIR] for HUE-AUTH-01", () => {
      expect(deriveFamilyActionHints("HUE-AUTH-01")).toEqual([HUE_RUNTIME_ACTION_HINT.REPAIR]);
    });

    it("returns [REPAIR] for HUE-AUTH-03", () => {
      expect(deriveFamilyActionHints("HUE-AUTH-03")).toEqual([HUE_RUNTIME_ACTION_HINT.REPAIR]);
    });

    it("returns [REPAIR] for HUE-AUTH-02", () => {
      expect(deriveFamilyActionHints("HUE-AUTH-02")).toEqual([HUE_RUNTIME_ACTION_HINT.REPAIR]);
    });
  });

  describe("HUE-STR family (new)", () => {
    it("returns [RETRY, ADJUST_AREA] for HUE-STR-01", () => {
      expect(deriveFamilyActionHints("HUE-STR-01")).toEqual([
        HUE_RUNTIME_ACTION_HINT.RETRY,
        HUE_RUNTIME_ACTION_HINT.ADJUST_AREA,
      ]);
    });

    it("returns [RETRY, ADJUST_AREA] for HUE-STR-04", () => {
      expect(deriveFamilyActionHints("HUE-STR-04")).toEqual([
        HUE_RUNTIME_ACTION_HINT.RETRY,
        HUE_RUNTIME_ACTION_HINT.ADJUST_AREA,
      ]);
    });
  });

  describe("HUE-CFG family (new)", () => {
    it("returns [REVALIDATE, ADJUST_AREA] for HUE-CFG-01", () => {
      expect(deriveFamilyActionHints("HUE-CFG-01")).toEqual([
        HUE_RUNTIME_ACTION_HINT.REVALIDATE,
        HUE_RUNTIME_ACTION_HINT.ADJUST_AREA,
      ]);
    });

    it("returns [REVALIDATE, ADJUST_AREA] for HUE-CFG-02", () => {
      expect(deriveFamilyActionHints("HUE-CFG-02")).toEqual([
        HUE_RUNTIME_ACTION_HINT.REVALIDATE,
        HUE_RUNTIME_ACTION_HINT.ADJUST_AREA,
      ]);
    });
  });

  describe("Existing families (regression)", () => {
    it("AUTH_INVALID_ returns [REPAIR]", () => {
      expect(deriveFamilyActionHints("AUTH_INVALID_CREDENTIALS")).toEqual([
        HUE_RUNTIME_ACTION_HINT.REPAIR,
      ]);
    });

    it("CONFIG_NOT_READY_ returns [REVALIDATE, ADJUST_AREA]", () => {
      expect(deriveFamilyActionHints("CONFIG_NOT_READY_GATE_BLOCKED")).toEqual([
        HUE_RUNTIME_ACTION_HINT.REVALIDATE,
        HUE_RUNTIME_ACTION_HINT.ADJUST_AREA,
      ]);
    });

    it("TRANSIENT_ returns [RETRY, RECONNECT]", () => {
      expect(deriveFamilyActionHints("TRANSIENT_RETRY_SCHEDULED")).toEqual([
        HUE_RUNTIME_ACTION_HINT.RETRY,
        HUE_RUNTIME_ACTION_HINT.RECONNECT,
      ]);
    });
  });

  describe("Edge cases", () => {
    it("returns [] for empty string", () => {
      expect(deriveFamilyActionHints("")).toEqual([]);
    });

    it("returns [] for null", () => {
      expect(deriveFamilyActionHints(null)).toEqual([]);
    });

    it("returns [] for unknown code", () => {
      expect(deriveFamilyActionHints("UNKNOWN_CODE")).toEqual([]);
    });
  });
});
