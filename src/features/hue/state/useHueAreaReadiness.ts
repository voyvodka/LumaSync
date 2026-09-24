import { useEffect } from "react";

import type { checkHueStreamReadiness, HueBridgeSummary, HuePairingCredentials } from "../hueOnboardingApi";
import { watchHueAreaReadiness } from "./hueHealthStore";
import { sameJson, selectHueAreaHealth, useHueHealth } from "./useHueHealth";

export interface UseHueAreaReadinessInput {
  bridge: HueBridgeSummary | null;
  credentials: HuePairingCredentials | null;
  areaId: string | null;
  /** Kept as two flags rather than one OR'd `paused`, so the effect's dep array
   * still reacts to each of them the way it did before the split. */
  isValidatingCredential: boolean;
  isLoadingAreas: boolean;
  onResult: (
    areaId: string,
    response: Awaited<ReturnType<typeof checkHueStreamReadiness>>,
    checkedAt: number,
  ) => void;
}

/**
 * The selected area's readiness while the Devices view is mounted. The health
 * monitor reads it — every 15 s, every 3 s while a foreign active streamer
 * holds it, which is what clears the banner without the user pressing
 * revalidate — and this hook only declares the interest and hands each answer
 * to the area rows.
 */
export function useHueAreaReadiness({
  bridge,
  credentials,
  areaId,
  isValidatingCredential,
  isLoadingAreas,
  onResult,
}: UseHueAreaReadinessInput): void {
  useEffect(() => watchHueAreaReadiness(), []);

  const area = useHueHealth(selectHueAreaHealth, sameJson);

  useEffect(() => {
    if (!area || !bridge || !credentials || !areaId || isValidatingCredential || isLoadingAreas) {
      return;
    }
    // Rust reads the saved area; a row the user just picked waits for its own.
    if (area.areaId !== areaId) return;
    onResult(area.areaId, { status: area.status, readiness: area.readiness }, area.checkedAtMs);
  }, [area, areaId, bridge, credentials, isLoadingAreas, isValidatingCredential, onResult]);
}
