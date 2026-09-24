import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { LocalSink } from "@/features/device/localSink";
import type { HueRuntimeTarget, HueRuntimeTriggerSource } from "@/shared/contracts/hue";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { useMirroredStore, useStoreSelector, type Store } from "@/shared/lib/store";
import { useStableHandlers } from "@/shared/lib/useStableCallback";

import type { ModeGuardReason } from "./modeGuard";

/**
 * What the mode controls read: the runtime snapshot as the orchestrator
 * shows it, and the non-Hue inputs that decide whether a mode may start.
 * The Hue ones still travel as props until the Hue health store replaces them.
 */
export interface LightingControlState {
  /** What runs, with the last colour and Ambilight settings kept through Off. */
  lightingMode: LightingModeConfig;
  /** The outputs the user chose, running or not. */
  outputTargets: HueRuntimeTarget[];
  /** This window's own choices in flight; see `useLightingModeOrchestrator`. */
  isModeTransitioning: boolean;
  modeLockReason: ModeGuardReason | null;
  calibration: LedCalibrationConfig | undefined;
  /** The bound local output — serial strip or WLED panel — or `null` for none. */
  localSink: LocalSink | null;
  /** The shell boot has settled. Before it the saved pairing is unread, so the
   *  output gate reports checking rather than "no reachable output". */
  bootstrapDone: boolean;
}

/** Apply, retune and release all go through the orchestrator's transaction. */
export interface LightingControlActions {
  /** A kind change is one `apply_outputs`; a nudge within the running kind is a coalesced retune. */
  changeMode: (next: LightingModeConfig) => void;
  changeOutputTargets: (targets: HueRuntimeTarget[]) => void;
  /** The Devices Hue card's stop, routed through the mode orchestrator. */
  stopHueOutput: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
  saveCalibration: (config: LedCalibrationConfig) => void;
}

interface LightingControl {
  store: Store<LightingControlState>;
  actions: LightingControlActions;
}

const LightingControlContext = createContext<LightingControl | null>(null);

/** Publishes `state` to the subscribers below; `actions` may be fresh closures every render. */
export function LightingControlProvider({
  state,
  actions,
  children,
}: {
  state: LightingControlState;
  actions: LightingControlActions;
  children: ReactNode;
}) {
  const store = useMirroredStore(state);
  const stableActions = useStableHandlers(actions);
  const value = useMemo(() => ({ store, actions: stableActions }), [store, stableActions]);
  return <LightingControlContext.Provider value={value}>{children}</LightingControlContext.Provider>;
}

function useLightingControl(): LightingControl {
  const control = useContext(LightingControlContext);
  if (control === null) throw new Error("LightingControl used outside LightingControlProvider");
  return control;
}

/** The slice `selector` picks; the caller re-renders only when that slice changes. */
export function useLightingControlState<S>(
  selector: (state: LightingControlState) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  return useStoreSelector(useLightingControl().store, selector, isEqual);
}

/** Identity-stable for the provider's lifetime. */
export function useLightingActions(): LightingControlActions {
  return useLightingControl().actions;
}
