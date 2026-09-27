/**
 * Plugging and unplugging, as the app actually experiences it.
 *
 * Editing `world.serial.connectedPort` in the panel does nothing on its own,
 * and that is not a bug in the panel — it is how the app works. The app hears
 * of a cable only through Rust's serial port watcher
 * (`device://serial-ports-changed`) and, for a pairing, the process-wide
 * `connectionEvents` bus (`state/siblingSync.ts`). So a world that says "unplugged" sits next to a UI
 * that still says "connected", with nothing to explain the disagreement. The
 * hot-plug edge — `wasConnected → false`, the disconnect toast, dropping
 * `usb` from the active targets — was unreachable from the mock entirely.
 *
 * These helpers flip the world and then publish on the same bus the real pair
 * path publishes on, so the app takes the identical route: re-read Rust,
 * reconcile, react.
 *
 * **Direction matters.** `mock/` importing `src/` is fine and already
 * pervasive; the ship-safety rule is that `src/` must never name `mock/`, and
 * `verify:mock-not-shipped` enforces exactly that. Importing these singletons
 * is the only way to reach the same instances the app holds — Vite dedupes by
 * resolved path, so there is one bus per tab.
 */

import { connectionEvents } from "../src/features/device/connectionEvents";
import { DEVICE_COMMANDS, DEVICE_EVENTS, type SerialPortsChangedEvent } from "../src/shared/contracts/device";
import { emitMockEvent } from "./events";
import { deviceHandlers } from "./handlers/device";
import { wledSinkEvents } from "../src/features/device/wledSinkEvents";
import type { WledUdpSinkConfig } from "../src/shared/contracts/device";
import type { ShellState } from "../src/shared/contracts/shell";
import { withSerialTransport, withoutWledDevice, withWledTransport } from "../src/features/strips/model/stripWrites";
import { getWorld, mutate } from "./state";

/**
 * Plug a strip in, or pull the cable.
 *
 * `portName` is required to unplug as well as to plug in: the bus carries the
 * port that changed, and a listener keyed on a different port must not react
 * to someone else's cable.
 */
export function setSerialConnected(portName: string, connected: boolean): void {
  mutate((w) => {
    w.serial.connectedPort = connected ? portName : null;
    if (connected) {
      w.shellState = { ...w.shellState, ...withSerialTransport(w.shellState as ShellState, portName) };
    }
  });
  connectionEvents.emit({ portName, connected });
  // What the watcher would say about the same cable.
  const event: SerialPortsChangedEvent = {
    ports: deviceHandlers[DEVICE_COMMANDS.LIST_PORTS]().ports,
    appeared: connected ? [portName] : [],
    lost: connected ? [] : [portName],
    connection: deviceHandlers[DEVICE_COMMANDS.GET_CONNECTION_STATUS](),
  };
  void emitMockEvent(DEVICE_EVENTS.SERIAL_PORTS_CHANGED, event);
}

/**
 * Reject the persisted port at boot, the way the allowlist does.
 *
 * `unsupportedReason` is the narrow signal that means "USB is structurally
 * unavailable this session", and App drops `usb` from the output targets on
 * it. Transient failures deliberately do not set it, so forcing a generic
 * connect failure through the panel reaches a different path than this does.
 */
export function rejectSerialPort(
  portName: string,
  reason: "PORT_UNSUPPORTED" | "PORT_NOT_FOUND",
): void {
  mutate((w) => {
    w.serial.connectedPort = null;
  });
  connectionEvents.emit({ portName, connected: false, unsupportedReason: reason });
}

/** Bind or unbind the WLED panel, announcing it the way boot restore does. */
export function setWledBound(host: string, bound: boolean): void {
  const device = getWorld().wled.devices.find((d) => d.host === host);
  if (device === undefined) return;

  const sink: WledUdpSinkConfig = {
    ip: device.host,
    port: device.port,
    ledCount: device.ledCount,
    protocol: device.protocol,
  };

  mutate((w) => {
    w.wled.connectedHost = bound ? host : null;
    const strips = bound
      ? withWledTransport(w.shellState as ShellState, sink)
      : withoutWledDevice(w.shellState as ShellState, sink.ip);
    w.shellState = { ...w.shellState, ...strips };
  });

  // `no-saved-device` rather than a synthetic failure: unbinding is not an
  // error, and a `failed` outcome would make the picker render a fault the
  // user did not cause.
  wledSinkEvents.publish(bound ? { kind: "restored", sink } : { kind: "no-saved-device" });
}
