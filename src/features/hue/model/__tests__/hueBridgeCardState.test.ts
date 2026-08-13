import { describe, expect, it } from "vitest";

import type { HueOnboardingStatus, HueRuntimeStatusView } from "../onboardingStatusCodes";
import {
  deriveHueBridgeCardState,
  type HueBridgeCardStateInput,
} from "../hueBridgeCardState";

const BASE: HueBridgeCardStateInput = {
  selectedBridgeId: "bridge-1",
  runtimeStatus: null,
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
    it("maps a rejected link button to pairingLinkButton, never authError", () => {
      expect(
        deriveHueBridgeCardState({
          ...BASE,
          credentialState: "needs_repair",
          hueStatus: status("HUE_PAIRING_LINK_BUTTON_NOT_PRESSED"),
        }),
      ).toBe("pairingLinkButton");
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

  it("falls back to pairing for an unknown credential state", () => {
    expect(deriveHueBridgeCardState({ ...BASE, credentialState: "unknown" })).toBe("pairing");
  });
});
