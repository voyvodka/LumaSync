import { hueUnavailableReason } from "@/features/hue/model/hueAvailability";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";

/** Whether a lighting mode has somewhere to send frames. `checking` is a paired
 * bridge whose first probe has not answered yet: it must neither enable the
 * modes nor be called "no output", since the "no output" copy asks the user to
 * pair a bridge that is already paired. */
export type OutputAvailability = "ready" | "checking" | "none";

export interface OutputAvailabilityInput {
  localOutputConnected: boolean;
  hueConfigured: boolean;
  hueReachable: boolean;
  hueProbeVerdict: HueProbeVerdict | null;
}

export function outputAvailability({
  localOutputConnected,
  hueConfigured,
  hueReachable,
  hueProbeVerdict,
}: OutputAvailabilityInput): OutputAvailability {
  if (localOutputConnected) return "ready";
  const reason = hueUnavailableReason(hueConfigured, hueReachable, hueProbeVerdict);
  if (reason === null) return "ready";
  return reason === "checking" ? "checking" : "none";
}
