import { useEffect, useState } from "react";

import { useStableCallback } from "@/shared/lib/useStableCallback";

import { createUpdateCheckScheduler } from "./updateCheckSchedule";
import type { BackgroundCheckOutcome } from "./useAutoUpdater";

/**
 * The launch check, then one a day while the app runs, with quicker retries
 * after a failure. A found update waits in the updater's `available` state,
 * which the prompt shows the next time the window is on screen.
 */
export function useBackgroundUpdateChecks(check: () => Promise<BackgroundCheckOutcome>): void {
  const stableCheck = useStableCallback(check);
  const [scheduler] = useState(() => createUpdateCheckScheduler(stableCheck));
  useEffect(() => {
    scheduler.start();
    return scheduler.stop;
  }, [scheduler]);
}
