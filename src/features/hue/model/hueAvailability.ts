import type { HueProbeVerdict } from "../state/useHueBridgeReachability";

export type HueUnavailableReason = "notConfigured" | "keyRejected" | "unreachable" | "checking";

/** Why Hue cannot be used right now, or `null` when it can. The Lights Hue row
 * and the room-aware chip both read this, so they never disagree. A paired
 * bridge is never "not configured": a rejected key and a silent bridge need
 * different next steps. */
export function hueUnavailableReason(
  configured: boolean,
  reachable: boolean,
  verdict: HueProbeVerdict | null,
): HueUnavailableReason | null {
  if (!configured) return "notConfigured";
  if (reachable) return null;
  if (verdict === "credentialRejected") return "keyRejected";
  if (verdict === null) return "checking";
  return "unreachable";
}
