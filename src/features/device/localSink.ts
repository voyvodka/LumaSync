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
 * Derived here rather than inline so the rule has one home and a test.
 */

export type LocalSink =
  | { transport: "serial"; /** OS port name, e.g. `/dev/cu.usbserial-1420`. */ id: string }
  | { transport: "wled"; /** LAN address — the only identity the persisted sink config keeps. */ id: string };

/**
 * Serial wins when both are bound.
 *
 * Not a preference: `ActiveSinkRegistry::replace` stops whatever was there, so
 * a serial connect evicts WLED and the registry holds the serial sink. Naming
 * WLED while Rust is driving the strip would be the same class of lie this
 * function exists to remove.
 */
export function deriveLocalSink(
  /** The app's own "a strip is connected" signal. Authoritative for the gate. */
  serialConnected: boolean,
  /** Port name, used only to identify the strip; absent is not "disconnected". */
  serialPort: string | null,
  activeWledIp: string | null,
): LocalSink | null {
  if (serialConnected) {
    return { transport: "serial", id: serialPort ?? "" };
  }
  if (activeWledIp !== null && activeWledIp.length > 0) {
    return { transport: "wled", id: activeWledIp };
  }
  return null;
}
