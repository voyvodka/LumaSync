import { useEffect, useState } from "react";

import { WLED_STATUS, type WledDeviceInfo, type WledDiscoveryResponse } from "@/shared/contracts/device";

import { browseWledDevices } from "../wledApi";

export interface WledBrowse {
  browsing: boolean;
  /** What answered the last browse as WLED, on the local network. */
  devices: readonly WledDeviceInfo[];
}

// One browse at a time: Rust holds the mDNS listener for the whole scan, so a second one only
// queues behind it. Pages opened meanwhile share the answer.
let inFlight: Promise<WledDiscoveryResponse> | null = null;

function browseOnce(browse: () => Promise<WledDiscoveryResponse>): Promise<WledDiscoveryResponse> {
  if (inFlight === null) {
    let started: Promise<WledDiscoveryResponse>;
    // A browse that throws is a rejection here, not a throw out of the effect.
    try {
      started = browse();
    } catch (error) {
      started = Promise.reject(error);
    }
    inFlight = started.finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Looks for WLED devices on the network each time `active` turns on. Never throws. */
export function useWledBrowse(active: boolean, browse: () => Promise<WledDiscoveryResponse> = browseWledDevices): WledBrowse {
  const [state, setState] = useState<WledBrowse>({ browsing: false, devices: [] });

  useEffect(() => {
    if (!active) return;
    let live = true;
    setState((current) => ({ ...current, browsing: true }));
    browseOnce(browse).then(
      (found) => {
        if (!live) return;
        const ok = found.status.code === WLED_STATUS.BROWSE_OK;
        // The address row is always there: a browse that could not run is logged, not shown.
        if (!ok) console.warn("[LumaSync] looking for WLED devices failed:", found.status.code, found.status.details);
        setState({ browsing: false, devices: ok ? found.devices : [] });
      },
      (error: unknown) => {
        console.error("[LumaSync] looking for WLED devices failed:", error);
        if (live) setState({ browsing: false, devices: [] });
      },
    );
    return () => {
      live = false;
      setState((current) => (current.browsing ? { ...current, browsing: false } : current));
    };
  }, [active, browse]);

  return state;
}
