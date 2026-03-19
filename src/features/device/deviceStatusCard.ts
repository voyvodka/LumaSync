import type { HealthCheckResult } from "./deviceConnectionApi";

export interface DeviceStatusCardModel {
  variant: "success" | "error" | "info";
  code: string;
  titleKey: string;
  bodyKey: string;
  details?: string;
}

export interface DeviceStatusCardInput {
  status: string;
  statusCard: {
    variant: "success" | "error" | "info";
    code: string;
    message: string;
    details?: string;
  } | null;
  connectedPort: string | null;
  isReconnecting?: boolean;
  isHealthChecking?: boolean;
  latestHealthCheck?: HealthCheckResult | null;
}

export function buildDeviceStatusCard(input: DeviceStatusCardInput): DeviceStatusCardModel {
  if (input.isHealthChecking) {
    return {
      variant: "info",
      code: "HEALTH_CHECK_IN_PROGRESS",
      titleKey: "device.healthCheck.inProgressTitle",
      bodyKey: "device.healthCheck.inProgressBody",
    };
  }

  if (input.isReconnecting) {
    return {
      variant: "info",
      code: "RECOVERY_IN_PROGRESS",
      titleKey: "device.status.reconnectingTitle",
      bodyKey: "device.status.reconnectingBody",
    };
  }

  const healthCheck = input.latestHealthCheck;
  if (healthCheck && !healthCheck.pass) {
    const firstFailed = healthCheck.steps.find((step) => !step.pass);
    return {
      variant: "error",
      code: "HEALTH_CHECK_FAIL",
      titleKey: "device.healthCheck.failTitle",
      bodyKey: "device.healthCheck.failBody",
      details: firstFailed?.message ?? firstFailed?.details ?? undefined,
    };
  }

  if (healthCheck && healthCheck.pass) {
    return {
      variant: "success",
      code: "HEALTH_CHECK_PASS",
      titleKey: "device.healthCheck.passTitle",
      bodyKey: "device.healthCheck.passBody",
    };
  }

  if (input.statusCard?.code === "SELECTED_PORT_MISSING") {
    return {
      variant: "info",
      code: "SELECTED_PORT_MISSING",
      titleKey: "device.status.missingTitle",
      bodyKey: "device.status.missingBody",
      details: input.statusCard.details,
    };
  }

  if (input.statusCard?.variant === "error") {
    return {
      variant: "error",
      code: input.statusCard.code,
      titleKey: "device.status.errorTitle",
      bodyKey: "device.status.errorBody",
      details: input.statusCard.details,
    };
  }

  if (input.statusCard?.variant === "success" || input.status === "connected") {
    return {
      variant: "success",
      code: input.statusCard?.code ?? "CONNECTED",
      titleKey: "device.status.connectedTitle",
      bodyKey: "device.status.connectedBody",
      details: input.connectedPort ?? undefined,
    };
  }

  if (input.status === "scanning") {
    return {
      variant: "info",
      code: "SCANNING",
      titleKey: "device.status.scanningTitle",
      bodyKey: "device.status.scanningBody",
    };
  }

  return {
    variant: "info",
    code: "IDLE",
    titleKey: "device.status.idleTitle",
    bodyKey: "device.status.idleBody",
  };
}
