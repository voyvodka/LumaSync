import { describe, expect, it } from "vitest";

import type { HueOnboardingStatus, HueRuntimeStatusView } from "../onboardingStatusCodes";
import {
  deriveHueBridgeCardState,
  hueStreamFailureReasonKey,
  type HueBridgeCardStateInput,
} from "../hueBridgeCardState";

const BASE: HueBridgeCardStateInput = {
  selectedBridgeId: "bridge-1",
  runtimeStatus: null,
  runtimeStatusUnavailable: false,
  hueStatus: null,
  credentialState: "valid",
  bridgeUnreachable: false,
  isPairing: false,
  selectedAreaId: "area-1",
  isReadinessStale: false,
};

const runtime = (partial: Partial<HueRuntimeStatusView>): HueRuntimeStatusView =>
  ({ state: "Idle", code: "HUE_STREAM_IDLE", message: "", details: null, triggerSource: "system", ...partial });

const status = (code: HueOnboardingStatus["code"]): HueOnboardingStatus => ({ code, message: "", details: null });

describe("deriveHueBridgeCardState", () => {
  it("returns null until a bridge is selected", () => {
    expect(deriveHueBridgeCardState({ ...BASE, selectedBridgeId: null })).toBeNull();
  });

  describe("runtime states outrank credential states", () => {
    it("reports a partial stop", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatus: runtime({ code: "HUE_STOP_TIMEOUT_PARTIAL" }) }),
      ).toBe("stopPartial");
    });

    it("reports a blocked config gate", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatus: runtime({ code: "CONFIG_NOT_READY_GATE_BLOCKED" }) }),
      ).toBe("gateBlocked");
    });

    it("reports a live stream", () => {
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus: runtime({ state: "Running" }) })).toBe("streaming");
    });

    it("reports reconnecting from the state", () => {
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus: runtime({ state: "Reconnecting" }) })).toBe(
        "reconnecting",
      );
    });

    it("reports reconnecting from any TRANSIENT_ code", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatus: runtime({ code: "TRANSIENT_RETRY_SCHEDULED" }) }),
      ).toBe("reconnecting");
    });

    it("prefers a running stream over an unreachable bridge", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatus: runtime({ state: "Running" }), bridgeUnreachable: true }),
      ).toBe("streaming");
    });
  });

  describe("offline outranks the re-pair prompt", () => {
    it("reports offline even when credentials need repair", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, bridgeUnreachable: true, credentialState: "needs_repair" }),
      ).toBe("offline");
    });
  });

  describe("needs_repair branches (#167)", () => {
    it("maps a link button still unpressed after the polling window to pairingTimedOut, never authError", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          credentialState: "needs_repair",
          hueStatus: status("HUE_PAIRING_LINK_BUTTON_NOT_PRESSED"),
        }),
      ).toBe("pairingTimedOut");
    });

    it("maps an ambiguous pairing failure to pairingFailed", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          credentialState: "needs_repair",
          hueStatus: status("HUE_PAIRING_FAILED"),
        }),
      ).toBe("pairingFailed");
    });

    it.each(["HUE_PAIRING_BRIDGE_BUSY", "HUE_PAIRING_RATE_LIMITED"] as const)(
      "maps %s to pairingDeferred, never authError",
      (code) => {
        expect(
          deriveHueBridgeCardState({ ...BASE, credentialState: "needs_repair", hueStatus: status(code) }),
        ).toBe("pairingDeferred");
      },
    );

    it("maps a rejected devicetype to pairingFailed", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          credentialState: "needs_repair",
          hueStatus: status("HUE_PAIRING_DEVICETYPE_INVALID"),
        }),
      ).toBe("pairingFailed");
    });

    it("falls through to authError for any other needs_repair reason", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          credentialState: "needs_repair",
          hueStatus: status("HUE_CREDENTIAL_INVALID"),
        }),
      ).toBe("authError");
    });

    it("falls through to authError when no status has arrived yet", () => {
      expect(deriveHueBridgeCardState({ ...BASE, credentialState: "needs_repair" })).toBe("authError");
    });

    it("skips the needs_repair branch entirely while a pairing is in flight", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          credentialState: "needs_repair",
          isPairing: true,
          hueStatus: status("HUE_CREDENTIAL_INVALID"),
        }),
      ).toBe("pairing");
    });
  });

  describe("in-flight pairing", () => {
    it("maps the pending link-button code to pairingLinkButton", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          isPairing: true,
          hueStatus: status("HUE_PAIRING_PENDING_LINK_BUTTON"),
        }),
      ).toBe("pairingLinkButton");
    });

    it("otherwise reports plain pairing", () => {
      expect(deriveHueBridgeCardState({ ...BASE, isPairing: true })).toBe("pairing");
    });
  });

  describe("valid credentials", () => {
    it("asks for an area when none is selected", () => {
      expect(deriveHueBridgeCardState({ ...BASE, selectedAreaId: null })).toBe("areaSelect");
    });

    it("reports stale readiness for a selected area", () => {
      expect(deriveHueBridgeCardState({ ...BASE, isReadinessStale: true })).toBe("stale");
    });

    it("reports idle when everything is settled", () => {
      expect(deriveHueBridgeCardState(BASE)).toBe("idle");
    });
  });

  describe("runtime status read rejected", () => {
    it("never reports Ready for a runtime it could not read", () => {
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatusUnavailable: true })).toBe("statusUnknown");
    });

    it("does not let the last status it read speak for the runtime", () => {
      for (const last of [
        runtime({ state: "Running" }),
        runtime({ state: "Reconnecting" }),
        runtime({ code: "HUE_STOP_TIMEOUT_PARTIAL" }),
      ]) {
        expect(
          deriveHueBridgeCardState({ ...BASE, runtimeStatus: last, runtimeStatusUnavailable: true }),
        ).toBe("statusUnknown");
      }
    });

    it("keeps states that come from the bridge or the credential, not the runtime", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatusUnavailable: true, bridgeUnreachable: true }),
      ).toBe("offline");
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatusUnavailable: true, credentialState: "needs_repair" }),
      ).toBe("authError");
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatusUnavailable: true, selectedAreaId: null }),
      ).toBe("areaSelect");
    });

    it("keeps a stale Failed status apart from the Failed the backend reports", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          runtimeStatus: runtime({ state: "Failed", code: "TRANSIENT_RETRY_EXHAUSTED" }),
          runtimeStatusUnavailable: true,
        }),
      ).toBe("statusUnknown");
    });
  });

  // Nothing mapped `Failed`, so a stream the backend had given up on fell
  // through to Ready — and a spent retry budget, being a TRANSIENT_ code, to a
  // reconnect that was no longer happening.
  describe("a backend-reported Failed stream", () => {
    const failed = (code: HueRuntimeStatusView["code"], partial: Partial<HueRuntimeStatusView> = {}) =>
      runtime({ state: "Failed", code, ...partial });

    it("reads as a stopped stream for every Failed code the runtime produces", () => {
      for (const code of ["TRANSIENT_RETRY_EXHAUSTED", "HUE_STREAM_START_ABORTED", "AUTH_INVALID_CREDENTIALS"] as const) {
        expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus: failed(code) }), code).toBe("streamFailed");
      }
    });

    it("never reads a spent retry budget as reconnecting", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatus: failed("TRANSIENT_RETRY_EXHAUSTED", { remainingAttempts: 0 }) }),
      ).toBe("streamFailed");
    });

    it("outranks a stale readiness check", () => {
      expect(
        deriveHueBridgeCardState({ ...BASE, runtimeStatus: failed("HUE_STREAM_START_ABORTED"), isReadinessStale: true }),
      ).toBe("streamFailed");
    });

    it("leaves an unreachable bridge, a refused credential and a pairing run their own cards", () => {
      const runtimeStatus = failed("TRANSIENT_RETRY_EXHAUSTED");
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus, bridgeUnreachable: true })).toBe("offline");
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus, credentialState: "needs_repair" })).toBe("authError");
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus, isPairing: true })).toBe("pairing");
      expect(deriveHueBridgeCardState({ ...BASE, runtimeStatus, selectedAreaId: null })).toBe("areaSelect");
    });

    it("explains each produced code in its own words and anything else with the generic line", () => {
      expect(hueStreamFailureReasonKey("TRANSIENT_RETRY_EXHAUSTED")).toBe("hue:runtime.codes.TRANSIENT_RETRY_EXHAUSTED");
      expect(hueStreamFailureReasonKey("HUE_STREAM_START_ABORTED")).toBe("hue:runtime.codes.HUE_STREAM_START_ABORTED");
      expect(hueStreamFailureReasonKey("AUTH_INVALID_CREDENTIALS")).toBe("hue:runtime.codes.AUTH_INVALID_CREDENTIALS");
      expect(hueStreamFailureReasonKey("HUE-NET-04")).toBe("hue:runtime.failed.body");
      expect(hueStreamFailureReasonKey("toString")).toBe("hue:runtime.failed.body");
      expect(hueStreamFailureReasonKey(null)).toBe("hue:runtime.failed.body");
    });
  });

  it("falls back to pairing for an unknown credential state", () => {
    expect(deriveHueBridgeCardState({ ...BASE, credentialState: "unknown" })).toBe("pairing");
  });
});
