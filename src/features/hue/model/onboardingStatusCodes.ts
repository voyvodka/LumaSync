import type {
  HueOnboardingWireStatusCode,
  HueRuntimeStatus,
  HueRuntimeWireStatusCode,
} from "@/shared/contracts/hue";
import type { CommandStatusOf } from "@/shared/contracts/status";

/** Synthesised when an `invoke()` itself rejects; the commands never throw.
 * The last three have no Rust producer — declaring them in a contract would
 * trip the verifier's phantom check, so they live here. */
export const HUE_ONBOARDING_TRANSPORT_CODES = {
  AREA_LIST_FAILED: "HUE_AREA_LIST_FAILED",
  DISCOVERY_FAILED: "HUE_DISCOVERY_FAILED",
  IP_UNREACHABLE: "HUE_IP_UNREACHABLE",
  PAIRING_FAILED: "HUE_PAIRING_FAILED",
  STREAM_READINESS_FAILED: "HUE_STREAM_READINESS_FAILED",
  CREDENTIAL_CHECK_FAILED: "HUE_CREDENTIAL_CHECK_FAILED",
  STREAM_START_FAILED: "HUE_STREAM_START_FAILED",
  STREAM_RECOVERY_FAILED: "HUE_STREAM_RECOVERY_FAILED",
  STREAM_STATUS_UNAVAILABLE: "HUE_STREAM_STATUS_UNAVAILABLE",
} as const;

export type HueOnboardingTransportCode =
  (typeof HUE_ONBOARDING_TRANSPORT_CODES)[keyof typeof HUE_ONBOARDING_TRANSPORT_CODES];

/** What the onboarding UI state holds: the wire union plus the codes above.
 * Kept out of the API surface so a minted code can never pose as a wire one. */
export type HueOnboardingStatus = CommandStatusOf<
  HueOnboardingWireStatusCode | HueOnboardingTransportCode
>;

/** Same split for the runtime status: what the Devices tab holds is the wire
 * status widened by the one code minted when the status poll itself rejects. */
export type HueRuntimeStatusView = Omit<HueRuntimeStatus, "code"> & {
  code: HueRuntimeWireStatusCode | typeof HUE_ONBOARDING_TRANSPORT_CODES.STREAM_STATUS_UNAVAILABLE;
};

/** Transport failures carry `error.message` and nothing else — never an object
 * that holds credentials. */
export function toErrorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
