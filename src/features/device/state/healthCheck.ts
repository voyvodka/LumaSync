import {
  DEVICE_OPERATION,
  DEVICE_STATUS,
  HEALTH_CHECK_NOT_AVAILABLE,
  type HealthCheckView,
} from "@/shared/contracts/device";
import type { FirmwareProfileEventBus } from "../firmwareProfileEvents";
import type { ConnectionStore } from "./connectionStore";
import type { DeviceConnectionControllerDeps } from "./connectionTypes";
import { parseCommandError } from "@/shared/contracts/status";

export interface HealthCheck {
  runHealthCheck(): Promise<void>;
}

export function createHealthCheck(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  firmwareProfileEventsBus: FirmwareProfileEventBus | null,
): HealthCheck {
  const now = deps.now ?? (() => Date.now());
  const runHealthCheckRequest: (portName: string) => Promise<HealthCheckView> =
    deps.runSerialHealthCheck ??
    (async () => ({
      pass: false,
      checkedAtUnixMs: now(),
      roundTripMs: null,
      firmwareVersion: null,
      advertisedFirmwareProfile: null,
      steps: [
        {
          step: "PORT_VISIBLE",
          pass: false,
          code: HEALTH_CHECK_NOT_AVAILABLE,
          message: "Health check bridge is not configured.",
          details: "Missing runSerialHealthCheck dependency.",
        },
      ],
    }));

  const runHealthCheck = async () => {
    const state = store.getState();
    if (!state.selectedPort || state.isScanning || state.isConnecting || state.isReconnecting) {
      return;
    }

    const token = store.beginOperation(DEVICE_OPERATION.HEALTH_CHECK);
    if (!token) {
      return;
    }

    const targetPort = state.selectedPort;
    store.setState((prev) => ({
      ...prev,
      statusCard: {
        variant: "info",
        code: "HEALTH_CHECK_IN_PROGRESS",
        message: "Running health check...",
        detailsKey: "device:status.hints.healthCheckInProgress",
      },
    }));

    // Health check runs the same DTR-reset + settle window as connect
    // (BOOTLOADER_SETTLE_DELAY_MS, device_connection.rs) — no client-side timeout.
    try {
      const result = await runHealthCheckRequest(targetPort);
      if (!store.isCurrentToken(token)) {
        return;
      }

      store.finishOperation(token);
      const firstFailedStep = result.steps.find((step) => !step.pass);
      store.setState((prev) => ({
        ...prev,
        status: result.pass ? prev.status : DEVICE_STATUS.ERROR,
        latestHealthCheck: result,
        statusCard: result.pass
          ? {
              variant: "success",
              code: "HEALTH_CHECK_PASS",
              message: "Health check passed.",
              detailsKey: "device:status.hints.healthCheckPassed",
            }
          : {
              variant: "error",
              code: "HEALTH_CHECK_FAIL",
              message: "Health check failed.",
              ...(firstFailedStep
                ? { details: firstFailedStep.message }
                : { detailsKey: "device:status.hints.healthCheckFailed" }),
            },
      }));

      // Lets FirmwareProfilePicker read the advertised profile without
      // mounting its own controller (and running its own health check).
      firmwareProfileEventsBus?.emit({
        advertisedFirmwareProfile: result.advertisedFirmwareProfile ?? undefined,
        advertisedPixelLayout: result.firmware?.pixelLayout,
      });
    } catch (error) {
      if (!store.isCurrentToken(token)) {
        return;
      }

      store.finishOperation(token);
      store.setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.ERROR,
        statusCard: {
          variant: "error",
          code: "HEALTH_CHECK_FAILED",
          message: "Health check could not be completed.",
          details: parseCommandError(error).message,
        },
      }));
    }
  };

  return { runHealthCheck };
}
