import { createContext, useContext, type ReactNode } from "react";

import { useStableHandlers } from "@/shared/lib/useStableCallback";

/** `alreadyDone`: every step's guard holds, so a restarted guide would show nothing. */
export type SetupGuideRestartResult = "shown" | "alreadyDone";

export interface SetupGuideActions {
  /** Brings the first-run guide back from its first unmet step. */
  restart: () => SetupGuideRestartResult;
}

const SetupGuideContext = createContext<SetupGuideActions | null>(null);

/** `actions` may be fresh closures every render. */
export function SetupGuideProvider({ actions, children }: { actions: SetupGuideActions; children: ReactNode }) {
  const stable = useStableHandlers(actions);
  return <SetupGuideContext.Provider value={stable}>{children}</SetupGuideContext.Provider>;
}

/** `null` outside the shell, where there is no guide to bring back. */
export function useSetupGuideActions(): SetupGuideActions | null {
  return useContext(SetupGuideContext);
}
