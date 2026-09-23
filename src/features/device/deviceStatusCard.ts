import type { TranslationKey } from "@/features/i18n/catalogue";
import type { SerialHealthStepCode } from "@/shared/contracts/device";

import type { HealthCheckResult } from "./deviceConnectionApi";

const HEALTH_STEP_ORDER = ["PORT_VISIBLE", "PORT_SUPPORTED", "CONNECT_AND_VERIFY"] as const;

type HealthStep = HealthCheckResult["steps"][number];

interface HealthCodeCopy {
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  /** Rust's `details` for this code is data (an OS error, VID/PID, a latency)
   *  rather than English advice, so it is shown verbatim under the text. */
  showDetails: boolean;
}

/** Rust's step `message` is English, so a known code renders from the
 *  catalogue and only an unknown one falls back to it. Literal keys, never a
 *  template: the orphan ratchet scans source text. */
const HEALTH_CODE_COPY: Partial<Record<SerialHealthStepCode, HealthCodeCopy>> = {
  SERIAL_HEALTH_OK: {
    labelKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_OK.label",
    hintKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_OK.hint",
    showDetails: true,
  },
  SERIAL_HEALTH_HANDSHAKE_TIMEOUT: {
    labelKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.label",
    hintKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.hint",
    showDetails: false,
  },
  SERIAL_HEALTH_VERSION_MISMATCH: {
    labelKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_VERSION_MISMATCH.label",
    hintKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_VERSION_MISMATCH.hint",
    showDetails: false,
  },
  SERIAL_HEALTH_FIRMWARE_MISMATCH: {
    labelKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_FIRMWARE_MISMATCH.label",
    hintKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_FIRMWARE_MISMATCH.hint",
    showDetails: false,
  },
  SERIAL_HEALTH_PROTOCOL_ERROR: {
    labelKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_PROTOCOL_ERROR.label",
    hintKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_PROTOCOL_ERROR.hint",
    showDetails: false,
  },
  SERIAL_HEALTH_WORKER_PANIC: {
    labelKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_WORKER_PANIC.label",
    hintKey: "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_WORKER_PANIC.hint",
    showDetails: true,
  },
  LIST_PORTS_FAILED: {
    labelKey: "device:healthCheck.serialHealthCodes.LIST_PORTS_FAILED.label",
    hintKey: "device:healthCheck.serialHealthCodes.LIST_PORTS_FAILED.hint",
    showDetails: true,
  },
  PORT_VISIBLE: {
    labelKey: "device:healthCheck.serialHealthCodes.PORT_VISIBLE.label",
    hintKey: "device:healthCheck.serialHealthCodes.PORT_VISIBLE.hint",
    showDetails: false,
  },
  // English advice on PORT_VISIBLE, an OS error on CONNECT_AND_VERIFY; the
  // label covers both.
  PORT_NOT_FOUND: {
    labelKey: "device:healthCheck.serialHealthCodes.PORT_NOT_FOUND.label",
    hintKey: "device:healthCheck.serialHealthCodes.PORT_NOT_FOUND.hint",
    showDetails: false,
  },
  PORT_SUPPORTED: {
    labelKey: "device:healthCheck.serialHealthCodes.PORT_SUPPORTED.label",
    hintKey: "device:healthCheck.serialHealthCodes.PORT_SUPPORTED.hint",
    showDetails: true,
  },
  PORT_UNSUPPORTED: {
    labelKey: "device:healthCheck.serialHealthCodes.PORT_UNSUPPORTED.label",
    hintKey: "device:healthCheck.serialHealthCodes.PORT_UNSUPPORTED.hint",
    showDetails: true,
  },
  CONNECT_OK: {
    labelKey: "device:healthCheck.serialHealthCodes.CONNECT_OK.label",
    hintKey: "device:healthCheck.serialHealthCodes.CONNECT_OK.hint",
    showDetails: false,
  },
  CONNECT_FAILED: {
    labelKey: "device:healthCheck.serialHealthCodes.CONNECT_FAILED.label",
    hintKey: "device:healthCheck.serialHealthCodes.CONNECT_FAILED.hint",
    showDetails: true,
  },
  CONNECT_INVALID_INPUT: {
    labelKey: "device:healthCheck.serialHealthCodes.CONNECT_INVALID_INPUT.label",
    hintKey: "device:healthCheck.serialHealthCodes.CONNECT_INVALID_INPUT.hint",
    showDetails: true,
  },
  CONNECT_PERMISSION_DENIED: {
    labelKey: "device:healthCheck.serialHealthCodes.CONNECT_PERMISSION_DENIED.label",
    hintKey: "device:healthCheck.serialHealthCodes.CONNECT_PERMISSION_DENIED.hint",
    showDetails: true,
  },
  CONNECT_TIMEOUT: {
    labelKey: "device:healthCheck.serialHealthCodes.CONNECT_TIMEOUT.label",
    hintKey: "device:healthCheck.serialHealthCodes.CONNECT_TIMEOUT.hint",
    showDetails: true,
  },
  CONNECT_IO_ERROR: {
    labelKey: "device:healthCheck.serialHealthCodes.CONNECT_IO_ERROR.label",
    hintKey: "device:healthCheck.serialHealthCodes.CONNECT_IO_ERROR.hint",
    showDetails: true,
  },
};

function healthCodeCopy(code: string): HealthCodeCopy | null {
  return Object.prototype.hasOwnProperty.call(HEALTH_CODE_COPY, code)
    ? HEALTH_CODE_COPY[code as SerialHealthStepCode] ?? null
    : null;
}

export interface DeviceStatusHealthStepText {
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  /** Safe to show untranslated; null when Rust's details are English prose. */
  details: string | null;
}

export interface DeviceStatusHealthStepModel {
  step: HealthStep["step"];
  pass: boolean;
  code: HealthStep["code"];
  /** Localized text for a known code; null means fall back to `message`/`details`. */
  text: DeviceStatusHealthStepText | null;
  message: string;
  details: string | null;
}

export interface DeviceStatusCardModel {
  variant: "success" | "error" | "info";
  code: string;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  details?: string;
  /** Wins over `details`: the localized label of a known failure code. */
  detailsKey?: TranslationKey;
  healthSteps?: DeviceStatusHealthStepModel[];
}

function mapHealthSteps(healthCheck: HealthCheckResult): DeviceStatusHealthStepModel[] {
  const rank = new Map<string, number>(HEALTH_STEP_ORDER.map((step, index) => [step, index]));
  return [...healthCheck.steps]
    .sort((left, right) => {
      const leftRank = rank.get(left.step) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.step) ?? Number.MAX_SAFE_INTEGER;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.step.localeCompare(right.step);
    })
    .map((step) => {
      const known = healthCodeCopy(step.code);
      return {
        step: step.step,
        pass: step.pass,
        code: step.code,
        text: known
          ? {
              labelKey: known.labelKey,
              hintKey: known.hintKey,
              details: known.showDetails ? step.details : null,
            }
          : null,
        message: step.message,
        details: step.details,
      };
    });
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
      titleKey: "device:healthCheck.inProgressTitle",
      bodyKey: "device:healthCheck.inProgressBody",
    };
  }

  if (input.isReconnecting) {
    return {
      variant: "info",
      code: "RECOVERY_IN_PROGRESS",
      titleKey: "device:status.reconnectingTitle",
      bodyKey: "device:status.reconnectingBody",
    };
  }

  const healthCheck = input.latestHealthCheck;
  if (healthCheck && !healthCheck.pass) {
    const firstFailed = healthCheck.steps.find((step) => !step.pass);
    const firstFailedCopy = firstFailed ? healthCodeCopy(firstFailed.code) : null;
    return {
      variant: "error",
      code: "HEALTH_CHECK_FAIL",
      titleKey: "device:healthCheck.failTitle",
      bodyKey: "device:healthCheck.failBody",
      ...(firstFailedCopy
        ? { detailsKey: firstFailedCopy.labelKey }
        : { details: firstFailed?.message ?? firstFailed?.details ?? undefined }),
      healthSteps: mapHealthSteps(healthCheck),
    };
  }

  if (healthCheck && healthCheck.pass) {
    return {
      variant: "success",
      code: "HEALTH_CHECK_PASS",
      titleKey: "device:healthCheck.passTitle",
      bodyKey: "device:healthCheck.passBody",
      healthSteps: mapHealthSteps(healthCheck),
    };
  }

  if (input.statusCard?.code === "SELECTED_PORT_MISSING") {
    return {
      variant: "info",
      code: "SELECTED_PORT_MISSING",
      titleKey: "device:status.missingTitle",
      bodyKey: "device:status.missingBody",
      details: input.statusCard.details,
    };
  }

  if (input.statusCard?.variant === "error") {
    return {
      variant: "error",
      code: input.statusCard.code,
      titleKey: "device:status.errorTitle",
      bodyKey: "device:status.errorBody",
      details: input.statusCard.details,
    };
  }

  if (input.statusCard?.variant === "success" || input.status === "connected") {
    return {
      variant: "success",
      code: input.statusCard?.code ?? "CONNECTED",
      titleKey: "device:status.connectedTitle",
      bodyKey: "device:status.connectedBody",
      details: input.connectedPort ?? undefined,
    };
  }

  if (input.status === "scanning") {
    return {
      variant: "info",
      code: "SCANNING",
      titleKey: "device:status.scanningTitle",
      bodyKey: "device:status.scanningBody",
    };
  }

  return {
    variant: "info",
    code: "IDLE",
    titleKey: "device:status.idleTitle",
    bodyKey: "device:status.idleBody",
  };
}
