/**
 * Which local output is bound right now, and how to name it.
 *
 * "Local" is everything that is not Hue: a serial strip or a WLED panel. The
 * backend has always treated them as one channel — `UsbOutputPlan` is
 * `Serial | Wled` and whichever sink the registry holds wins — but the UI only
 * ever asked whether a *serial port* was connected. A user with a working WLED
 * panel and no strip was therefore told "No strip connected", every non-Off
 * mode stayed disabled, and the output they owned was unreachable.
 *
 * Which one is bound is Rust's to say: `localSinkOf` in `model/localOutputs.ts` reads it from the
 * registry snapshot's `driven`.
 */

export type LocalSink =
  | {
      transport: "serial";
      /** OS port name, e.g. `/dev/cu.usbserial-1420`. */
      id: string;
      /** USB product string the OS reported for the port, when it reported one. */
      product?: string;
    }
  | { transport: "wled"; /** LAN address — the only identity the persisted sink config keeps. */ id: string };
