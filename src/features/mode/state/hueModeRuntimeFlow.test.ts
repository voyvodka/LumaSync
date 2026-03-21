import { describe, expect, it } from "vitest";

import {
  applyRuntimeResultToTargets,
  resolveHueRuntimePlan,
} from "./hueModeRuntimeFlow";

describe("hueModeRuntimeFlow", () => {
  it("produces deterministic start steps for usb, hue, and dual targets", () => {
    const usbOnly = resolveHueRuntimePlan({
      action: "start",
      selectedTargets: ["usb"],
      activeTargets: [],
    });

    const hueOnly = resolveHueRuntimePlan({
      action: "start",
      selectedTargets: ["hue"],
      activeTargets: [],
    });

    const dual = resolveHueRuntimePlan({
      action: "start",
      selectedTargets: ["hue", "usb"],
      activeTargets: [],
    });

    expect(usbOnly.steps).toEqual(["start:usb"]);
    expect(hueOnly.steps).toEqual(["start:hue"]);
    expect(dual.steps).toEqual(["start:usb", "start:hue"]);
  });

  it("keeps healthy targets running when one target fails to start", () => {
    const plan = resolveHueRuntimePlan({
      action: "start",
      selectedTargets: ["usb", "hue"],
      activeTargets: [],
    });

    const result = applyRuntimeResultToTargets(plan, {
      usb: { ok: true },
      hue: { ok: false, code: "HUE_GATE_BLOCKED", message: "Bridge not ready" },
    });

    expect(result.outcome).toBe("partial_start");
    expect(result.activeTargets).toEqual(["usb"]);
    expect(result.stoppedTargets).toEqual([]);
    expect(result.failedTargets).toEqual(["hue"]);
  });

  it("suppresses reconnect planning when a user stop is requested", () => {
    const plan = resolveHueRuntimePlan({
      action: "stop",
      selectedTargets: ["usb", "hue"],
      activeTargets: ["usb", "hue"],
      stopTarget: "hue",
      userInitiated: true,
      reconnectingTargets: ["hue"],
    });

    expect(plan.allowReconnect).toBe(false);
    expect(plan.stopTargets).toEqual(["hue"]);
    expect(plan.steps).toContain("cancel-reconnect:hue");
  });
});
