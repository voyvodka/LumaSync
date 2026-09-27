import { useCallback, useState } from "react";

import { WLED_STATUS, type WledCommandStatus, type WledDeviceInfo } from "@/shared/contracts/device";
import { parseCommandError } from "@/shared/contracts/status";

import { connectWledSink, discoverWledDevices } from "../wledApi";

export interface WledConnectDeps {
  discover?: typeof discoverWledDevices;
  connect?: typeof connectWledSink;
}

export interface WledConnect {
  /** The address being connected, `null` when none is. */
  connecting: string | null;
  /**
   * Asks the device at `ip` what it is (its LED count), binds it, then `onBound` records it — the
   * saved strip and the switch away from the other outputs. Never throws: the answer is a status.
   */
  connect: (ip: string, onBound: (device: WledDeviceInfo) => Promise<void>) => Promise<WledCommandStatus>;
}

const failed = (error: unknown): WledCommandStatus => ({
  code: WLED_STATUS.BRIDGE_UNREACHABLE,
  message: parseCommandError(error).message,
  details: null,
});

export function useWledConnect({ discover = discoverWledDevices, connect = connectWledSink }: WledConnectDeps = {}): WledConnect {
  const [connecting, setConnecting] = useState<string | null>(null);

  const run = useCallback(
    async (ip: string, onBound: (device: WledDeviceInfo) => Promise<void>): Promise<WledCommandStatus> => {
      setConnecting(ip.trim());
      try {
        const found = await discover(ip.trim());
        const device = found.devices?.[0];
        if (found.status.code !== WLED_STATUS.DISCOVERY_OK || device === undefined) return found.status;
        const bound = await connect(device);
        if (bound.status.code === WLED_STATUS.CONNECT_OK) await onBound(device);
        return bound.status;
      } catch (error) {
        console.error("[LumaSync] connecting the WLED device failed:", error);
        return failed(error);
      } finally {
        setConnecting(null);
      }
    },
    [discover, connect],
  );

  return { connecting, connect: run };
}
