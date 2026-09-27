import type { DrivenOutputRef, LocalOutputsSnapshot } from "@/shared/contracts/device";

import { disconnectSerialPort } from "../deviceConnectionApi";
import { sameDriven } from "../model/localOutputs";
import { forgetWledDevice } from "../wledApi";
import { localOutputs } from "./localOutputsStore";

export interface ReleaseOthersDeps {
  read: () => Promise<LocalOutputsSnapshot | null>;
  disconnectSerial: (portName: string) => Promise<unknown>;
  forgetWled: (ip: string) => Promise<unknown>;
}

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
        if (output.kind === "serial") await deps.disconnectSerial(output.portName);
        else await deps.forgetWled(output.ip);
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
    disconnectSerial: disconnectSerialPort,
    forgetWled: forgetWledDevice,
  });
}
