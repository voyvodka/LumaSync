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
});
