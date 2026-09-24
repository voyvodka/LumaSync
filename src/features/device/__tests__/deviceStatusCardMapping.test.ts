import { describe, expect, it } from "vitest";

import { buildDeviceStatusCard } from "../deviceStatusCard";

describe("device status card mapping", () => {
  it("maps reconnecting to info card with manual fallback guidance", () => {
    const card = buildDeviceStatusCard({
      status: "reconnecting",
      statusCard: null,
      connectedPort: "COM3",
      isReconnecting: true,
      isHealthChecking: false,
      latestHealthCheck: null,
    });

    expect(card.variant).toBe("info");
    expect(card.code).toBe("RECOVERY_IN_PROGRESS");
    expect(card.titleKey).toBe("device:status.reconnectingTitle");
    expect(card.bodyKey).toBe("device:status.reconnectingBody");
  });

  it("maps health check fail to persistent error with actionable context", () => {
    const card = buildDeviceStatusCard({
      status: "ready",
      statusCard: null,
      connectedPort: null,
      isReconnecting: false,
      isHealthChecking: false,
      latestHealthCheck: {
        pass: false,
        checkedAtUnixMs: Date.now(),
        roundTripMs: null,
        firmwareVersion: null,
        advertisedFirmwareProfile: null,
        steps: [
          { step: "PORT_VISIBLE", pass: true, code: "PORT_VISIBLE", message: "visible", details: null },
          { step: "PORT_SUPPORTED", pass: false, code: "PORT_UNSUPPORTED", message: "choose another port", details: null },
          { step: "CONNECT_AND_VERIFY", pass: false, code: "CONNECT_FAILED", message: "failed", details: "check cable" },
        ],
      },
    });

    expect(card.variant).toBe("error");
    expect(card.code).toBe("HEALTH_CHECK_FAIL");
    expect(card.titleKey).toBe("device:healthCheck.failTitle");
    // A known code is summarised by its catalogue label, never Rust's English.
    expect(card.details).toBeUndefined();
    expect(card.detailsKey).toBe("device:healthCheck.serialHealthCodes.PORT_UNSUPPORTED.label");
    expect(card.healthSteps).toEqual([
      {
        step: "PORT_VISIBLE",
        pass: true,
        code: "PORT_VISIBLE",
        text: {
          labelKey: "device:healthCheck.serialHealthCodes.PORT_VISIBLE.label",
          hintKey: "device:healthCheck.serialHealthCodes.PORT_VISIBLE.hint",
          details: null,
        },
        message: "visible",
        details: null,
      },
      {
        step: "PORT_SUPPORTED",
        pass: false,
        code: "PORT_UNSUPPORTED",
        text: {
          labelKey: "device:healthCheck.serialHealthCodes.PORT_UNSUPPORTED.label",
          hintKey: "device:healthCheck.serialHealthCodes.PORT_UNSUPPORTED.hint",
          details: null,
        },
        message: "choose another port",
        details: null,
      },
      {
        step: "CONNECT_AND_VERIFY",
        pass: false,
        code: "CONNECT_FAILED",
        text: {
          labelKey: "device:healthCheck.serialHealthCodes.CONNECT_FAILED.label",
          hintKey: "device:healthCheck.serialHealthCodes.CONNECT_FAILED.hint",
          details: "check cable",
        },
        message: "failed",
        details: "check cable",
      },
    ]);
  });

  it("maps health check pass and preserves full step outcomes", () => {
    const card = buildDeviceStatusCard({
      status: "connected",
      statusCard: null,
      connectedPort: "COM3",
      isReconnecting: false,
      isHealthChecking: false,
      latestHealthCheck: {
        pass: true,
        checkedAtUnixMs: Date.now(),
        roundTripMs: null,
        firmwareVersion: null,
        advertisedFirmwareProfile: null,
        steps: [
          { step: "CONNECT_AND_VERIFY", pass: true, code: "CONNECT_OK", message: "connected", details: null },
          { step: "PORT_VISIBLE", pass: true, code: "PORT_VISIBLE", message: "visible", details: null },
          { step: "PORT_SUPPORTED", pass: true, code: "PORT_SUPPORTED", message: "supported", details: null },
        ],
      },
    });

    expect(card.variant).toBe("success");
    expect(card.code).toBe("HEALTH_CHECK_PASS");
    expect(card.healthSteps?.map(({ step, code, message }) => ({ step, code, message }))).toEqual([
      { step: "PORT_VISIBLE", code: "PORT_VISIBLE", message: "visible" },
      { step: "PORT_SUPPORTED", code: "PORT_SUPPORTED", message: "supported" },
      { step: "CONNECT_AND_VERIFY", code: "CONNECT_OK", message: "connected" },
    ]);
  });

  it("summarises an unknown failure code with Rust's message", () => {
    const card = buildDeviceStatusCard({
      status: "ready",
      statusCard: null,
      connectedPort: null,
      latestHealthCheck: {
        pass: false,
        checkedAtUnixMs: 0,
        roundTripMs: null,
        firmwareVersion: null,
        advertisedFirmwareProfile: null,
        steps: [
          { step: "PORT_VISIBLE", pass: false, code: "HEALTH_CHECK_NOT_AVAILABLE", message: "bridge missing", details: null },
        ],
      },
    });

    expect(card.detailsKey).toBeUndefined();
    expect(card.details).toBe("bridge missing");
    expect(card.healthSteps?.[0]?.text).toBeNull();
  });

  it("keeps active operation precedence over stale cards", () => {
    const card = buildDeviceStatusCard({
      status: "reconnecting",
      statusCard: {
        variant: "error",
        code: "CONNECT_FAILED",
        message: "failed",
      },
      connectedPort: null,
      isReconnecting: true,
      isHealthChecking: false,
      latestHealthCheck: {
        pass: false,
        checkedAtUnixMs: Date.now(),
        roundTripMs: null,
        firmwareVersion: null,
        advertisedFirmwareProfile: null,
        steps: [
          { step: "PORT_VISIBLE", pass: true, code: "PORT_VISIBLE", message: "visible", details: null },
          { step: "PORT_SUPPORTED", pass: false, code: "PORT_UNSUPPORTED", message: "unsupported", details: null },
          { step: "CONNECT_AND_VERIFY", pass: false, code: "CONNECT_FAILED", message: "failed", details: null },
        ],
      },
    });

    expect(card.code).toBe("RECOVERY_IN_PROGRESS");
    expect(card.variant).toBe("info");
  });

  // Advice the controller minted is a catalogue key, so it reaches the user
  // translated; only backend text (an OS error) is shown verbatim.
  it("renders minted advice through i18n and keeps backend text verbatim", () => {
    const minted = buildDeviceStatusCard({
      status: "error",
      statusCard: {
        variant: "error",
        code: "RECOVERY_MANUAL_REQUIRED",
        message: "Auto-recovery timed out.",
        detailsKey: "device:status.hints.recoveryTimedOut",
      },
      connectedPort: null,
    });
    expect(minted.detailsKey).toBe("device:status.hints.recoveryTimedOut");
    expect(minted.details).toBeUndefined();

    const missing = buildDeviceStatusCard({
      status: "ready",
      statusCard: {
        variant: "info",
        code: "SELECTED_PORT_MISSING",
        message: "Previously selected port is no longer available.",
        detailsKey: "device:status.hints.selectedPortMissing",
      },
      connectedPort: null,
    });
    expect(missing.detailsKey).toBe("device:status.hints.selectedPortMissing");

    const backend = buildDeviceStatusCard({
      status: "error",
      statusCard: {
        variant: "error",
        code: "CONNECT_FAILED",
        message: "Could not connect to the selected port.",
        details: "Access is denied. (os error 5)",
      },
      connectedPort: null,
    });
    expect(backend.details).toBe("Access is denied. (os error 5)");
    expect(backend.detailsKey).toBeUndefined();
  });
});

// A failed connect used to read "Connection attempt failed" whatever Rust
// said, with Rust's English appended; the catalogue already had the words.
describe("connect failures in the user's language", () => {
  it.each([
    "PORT_UNSUPPORTED",
    "CONNECT_PERMISSION_DENIED",
    "CONNECT_IO_ERROR",
    "CONNECT_TIMEOUT",
  ] as const)("names %s from the catalogue", (code) => {
    const card = buildDeviceStatusCard({
      status: "error",
      statusCard: { variant: "error", code, message: "English from Rust", details: "os error 16" },
      connectedPort: null,
    });
    expect(card.titleKey).toBe(`device:healthCheck.serialHealthCodes.${code}.label`);
    expect(card.bodyKey).toBe(`device:healthCheck.serialHealthCodes.${code}.hint`);
    // The OS error is data and stays; Rust's sentence never reaches the card.
    expect(card.details).toBe("os error 16");
  });

  it("keeps the generic copy and Rust's text for a code it does not know", () => {
    const card = buildDeviceStatusCard({
      status: "error",
      statusCard: { variant: "error", code: "CONNECT_SOMETHING_NEW", message: "m", details: "raw" },
      connectedPort: null,
    });
    expect(card.titleKey).toBe("device:status.errorTitle");
    expect(card.details).toBe("raw");
  });
});

describe("advice the controller minted", () => {
  // A Rescan too soon used to fall through to the idle card and say nothing.
  it.each([
    ["REFRESH_RATE_LIMITED", "device:status.hints.refreshRateLimited"],
    ["RECOVERY_CANCELLED_BY_USER", "device:status.hints.recoveryCancelled"],
  ] as const)("shows %s under the state it applies to", (code, detailsKey) => {
    const idle = buildDeviceStatusCard({
      status: "ready",
      statusCard: { variant: "info", code, message: "m", detailsKey },
      connectedPort: null,
      ports: [{ isSupported: true }],
    });
    expect(idle).toMatchObject({ code: "IDLE", detailsKey });

    const connected = buildDeviceStatusCard({
      status: "connected",
      statusCard: { variant: "info", code, message: "m", detailsKey },
      connectedPort: "COM3",
    });
    expect(connected).toMatchObject({ variant: "success", titleKey: "device:status.connectedTitle", detailsKey });
  });
});

describe("the idle card", () => {
  it("names the port once, in the sentence", () => {
    const card = buildDeviceStatusCard({ status: "connected", statusCard: null, connectedPort: "COM3" });
    expect(card.bodyKey).toBe("device:status.connectedBody");
    expect(card.details).toBeUndefined();
  });

  it("says why there is nothing to connect", () => {
    const base = { status: "ready", statusCard: null, connectedPort: null };
    expect(buildDeviceStatusCard({ ...base, ports: [] }).code).toBe("NO_PORTS");
    expect(buildDeviceStatusCard({ ...base, ports: [{ isSupported: false }] })).toMatchObject({
      code: "NO_SUPPORTED_PORTS",
      titleKey: "device:status.noSupportedTitle",
    });
    expect(buildDeviceStatusCard({ ...base, ports: [{ isSupported: true }] }).code).toBe("IDLE");
  });
});
