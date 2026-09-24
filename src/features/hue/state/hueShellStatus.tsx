import { createContext, useContext, type ReactNode } from "react";

import { useMirroredStore, useStoreSelector, type Store } from "@/shared/lib/store";

import type { HueProbeVerdict } from "./useHueBridgeReachability";

/**
 * The Hue status the sections and layouts show, as the shell folds it: the
 * health monitor's snapshot read against this window's saved pairing and the
 * outputs the running mode drives. Published once by the shell; each consumer
 * selects its own slice, so a probe tick re-renders only what shows it.
 */
export interface HueShellStatus {
  /** A bridge, an area and a pairing are saved (`toHueStartConfig`). */
  configured: boolean;
  /** The probe found the bridge, or a stream the app owns proves it. */
  reachable: boolean;
  /** What the last bridge probe found; `null` while the first one is in flight. */
  probeVerdict: HueProbeVerdict | null;
  streaming: boolean;
  /** Hue session owned but the backend is retrying the bridge; overrides `streaming`. */
  reconnecting: boolean;
  streamFailed: boolean;
}

export const HUE_SHELL_STATUS_NONE: HueShellStatus = {
  configured: false,
  reachable: false,
  probeVerdict: null,
  streaming: false,
  reconnecting: false,
  streamFailed: false,
};

const HueShellStatusContext = createContext<Store<HueShellStatus> | null>(null);

export function HueShellStatusProvider({
  status,
  children,
}: {
  status: HueShellStatus;
  children: ReactNode;
}) {
  const store = useMirroredStore(status);
  return <HueShellStatusContext.Provider value={store}>{children}</HueShellStatusContext.Provider>;
}

/** The slice `selector` picks; the caller re-renders only when that slice changes. */
export function useHueShellStatus<S>(
  selector: (status: HueShellStatus) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  const store = useContext(HueShellStatusContext);
  if (store === null) throw new Error("useHueShellStatus used outside HueShellStatusProvider");
  return useStoreSelector(store, selector, isEqual);
}
