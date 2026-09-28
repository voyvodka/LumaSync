import {
  SERIAL_DISCONNECT_STATUS,
  WLED_STATUS,
  type DrivenOutputRef,
  type LocalOutputsSnapshot,
} from "@/shared/contracts/device";

import { disconnectSerialPort } from "../deviceConnectionApi";
import { sameDriven } from "../model/localOutputs";
import { forgetWledDevice } from "../wledApi";
import { localOutputs } from "./localOutputsStore";

export interface ReleaseOthersDeps {
  read: () => Promise<LocalOutputsSnapshot | null>;
  /** Resolves with the command's status code. */
  disconnectSerial: (portName: string) => Promise<string>;
  forgetWled: (ip: string) => Promise<string>;
}

const RELEASED: ReadonlySet<string> = new Set([
  SERIAL_DISCONNECT_STATUS.OK,
  SERIAL_DISCONNECT_STATUS.NOT_CONNECTED,
  WLED_STATUS.FORGET_OK,
]);

/**
 * One local output at a time, as the user sees it, while Rust can drive several: after the user
 * connects one, every other connected output is let go of. Each release is its own attempt, so one
 * that fails leaves the rest to go; nothing here throws.
 */
export async function releaseOtherLocalOutputs(kept: DrivenOutputRef, deps: ReleaseOthersDeps): Promise<void> {
  const snapshot = await deps.read();
  const others = (snapshot?.outputs ?? []).filter((output) => {
    if (!output.connected) return false;
    const ref: DrivenOutputRef =
      output.kind === "serial" ? { kind: "serial", portName: output.portName } : { kind: "wled", ip: output.ip };
    return !sameDriven(ref, kept);
  });
  await Promise.all(
    others.map(async (output) => {
      try {
        const code =
          output.kind === "serial" ? await deps.disconnectSerial(output.portName) : await deps.forgetWled(output.ip);
        // Still connected: the next connect of it, or a restart, is where it goes.
        if (!RELEASED.has(code)) console.warn("[LumaSync] another local output was not let go of:", code);
      } catch (error) {
        console.error("[LumaSync] letting go of another local output failed:", error);
      }
    }),
  );
}

/** The app's switch: reads the registry, then lets go of every other output through Rust. */
export function releaseOthersInApp(kept: DrivenOutputRef): Promise<void> {
  return releaseOtherLocalOutputs(kept, {
    read: () => localOutputs.refresh(),
    disconnectSerial: async (portName) => (await disconnectSerialPort(portName)).status.code,
    forgetWled: async (ip) => (await forgetWledDevice(ip)).status.code,
  });
}
