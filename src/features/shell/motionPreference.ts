import { followPreference, hydratePreferences } from "@/features/persistence/preferences";
import type { ShellState } from "@/shared/contracts/shell";
import { applyReducedMotion } from "@/shared/lib/motion";

let following = false;

/**
 * Settings → Appearance "Reduce motion" in this window: applied from the boot read, then kept in
 * step with a change made in any window. The OS request applies whatever the read says, so a failed
 * or missing read still honours it.
 */
export function followMotionPreference(boot?: Promise<ShellState>): void {
  applyReducedMotion(false);
  if (following) return;
  following = true;
  followPreference("motion", (motion) => applyReducedMotion(motion === "reduce"));
  if (!boot) {
    hydratePreferences();
    return;
  }
  boot.then(
    (state) => hydratePreferences(state),
    // The language step reports the read's failure; this one still has to start following.
    () => hydratePreferences(),
  );
}
