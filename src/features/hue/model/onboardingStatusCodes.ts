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

/** Transport failures carry `error.message` and nothing else — never an object
 * that holds credentials. */
export function toErrorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
