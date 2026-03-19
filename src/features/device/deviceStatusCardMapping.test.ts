import { describe, expect, it } from "vitest";

import { buildDeviceStatusCard } from "./deviceStatusCard";

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
    expect(card.titleKey).toBe("device.status.reconnectingTitle");
    expect(card.bodyKey).toBe("device.status.reconnectingBody");
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
    expect(card.titleKey).toBe("device.healthCheck.failTitle");
    expect(card.details).toBe("choose another port");
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
