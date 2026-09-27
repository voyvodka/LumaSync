import {
  DEVICE_ERROR_CODES,
  SERIAL_CONNECT_STATUS,
  SERIAL_OUTPUT_STATUS,
  type LocalOutputsSnapshot,
  type SerialCommandStatusCode,
  type SerialConnectionStatus,
  type SerialOutputStatus,
} from "@/shared/contracts/device";

import type { DeviceConnectionControllerDeps } from "../../state/connectionTypes";
import { createLocalOutputs, type LocalOutputs } from "../../state/localOutputsStore";

/** Refused before a port was opened: Rust records no entry for the name. */
const NOT_ADMITTED: ReadonlySet<string> = new Set([
  DEVICE_ERROR_CODES.PORT_NOT_FOUND,
  DEVICE_ERROR_CODES.PORT_UNSUPPORTED,
  SERIAL_CONNECT_STATUS.INVALID_INPUT,
]);

export interface FakeRegistry {
  outputs: LocalOutputs;
  snapshot: () => LocalOutputsSnapshot;
  /** Wraps a `connectSerialPort` double so its answers land in the registry, as Rust's do. */
  recording: <Rest extends unknown[]>(
    connect: (portName: string, ...rest: Rest) => Promise<SerialConnectionStatus>,
  ) => (portName: string, ...rest: Rest) => Promise<SerialConnectionStatus>;
  connect: (portName: string) => void;
  /** The watcher found the port gone. */
  unplug: (portName: string) => void;
  /** Let go of: a disconnect, or the switch after another connect. */
  release: (portName: string) => void;
  bindWled: (ip: string, ledCount?: number) => void;
  forgetWled: () => void;
}

/**
 * Rust's local-output registry for tests: several outputs can be connected and the earliest connected
 * is driven (a connect never moves it), a revision per change, and an event per change to whoever
 * listens.
 */
export function fakeRegistry(initial: { connected?: string } = {}): FakeRegistry {
  let revision = 0;
  const serial = new Map<string, SerialOutputStatus>();
  let wled: { ip: string; ledCount: number } | null = null;
  // Connect order, earliest first: `serial:<port>` and `wled`.
  let order: string[] = [];
  const listeners = new Set<(snapshot: LocalOutputsSnapshot) => void>();

  const snapshot = (): LocalOutputsSnapshot => {
    const outputs: LocalOutputsSnapshot["outputs"] = [...serial.values()]
      .sort((a, b) => a.portName.localeCompare(b.portName))
      .map((entry) => ({ kind: "serial" as const, ...entry }));
    if (wled) outputs.push({ kind: "wled", ip: wled.ip, ledCount: wled.ledCount, connected: true });
    const first = order.find((key) => (key === "wled" ? wled !== null : serial.get(key.slice(7))?.connected));
    const driven =
      first === undefined
        ? null
        : first === "wled" && wled
          ? ({ kind: "wled", ip: wled.ip } as const)
          : ({ kind: "serial", portName: first.slice(7) } as const);
    return { revision, outputs, driven };
  };

  const changed = () => {
    revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  };

  const entry = (portName: string, connected: boolean, code: SerialCommandStatusCode): SerialOutputStatus => ({
    portName,
    connected,
    status: { code, message: code, details: null },
    firmware: null,
    updatedAtUnixMs: revision + 1,
  });

  const leave = (key: string) => {
    order = order.filter((held) => held !== key);
  };

  const connect = (portName: string) => {
    if (!serial.get(portName)?.connected) order.push(`serial:${portName}`);
    serial.set(portName, entry(portName, true, SERIAL_CONNECT_STATUS.OK));
    changed();
  };

  const failed = (portName: string, code: SerialCommandStatusCode) => {
    if (NOT_ADMITTED.has(code) || serial.get(portName)?.connected) {
      changed();
      return;
    }
    serial.set(portName, entry(portName, false, code));
    changed();
  };

  const outputs = createLocalOutputs({
    read: async () => snapshot(),
    listen: async (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  });

  if (initial.connected) connect(initial.connected);

  return {
    outputs,
    snapshot,
    recording:
      (connectDouble) =>
      async (portName, ...rest) => {
        const answer = await connectDouble(portName, ...rest);
        // A double with no answer set is one the test never expects to be called.
        if (answer === undefined) return answer;
        if (answer.connected && answer.portName) connect(answer.portName);
        else failed(portName, answer.status.code);
        return answer;
      },
    connect,
    unplug: (portName) => {
      const current = serial.get(portName);
      if (!current?.connected) return;
      serial.set(portName, entry(portName, false, DEVICE_ERROR_CODES.PORT_NOT_FOUND));
      leave(`serial:${portName}`);
      changed();
    },
    release: (portName) => {
      if (!serial.get(portName)?.connected) return;
      serial.set(portName, entry(portName, false, SERIAL_OUTPUT_STATUS.DISCONNECTED));
      leave(`serial:${portName}`);
      changed();
    },
    bindWled: (ip, ledCount = 60) => {
      if (wled?.ip !== ip) {
        leave("wled");
        order.push("wled");
      }
      wled = { ip, ledCount };
      changed();
    },
    forgetWled: () => {
      if (wled === null) return;
      wled = null;
      leave("wled");
      changed();
    },
  };
}

/** Controller deps backed by `registry`: its connects are recorded there, and the controller follows it. */
export function withRegistry(
  deps: Omit<DeviceConnectionControllerDeps, "localOutputs">,
  registry: FakeRegistry = fakeRegistry(),
): DeviceConnectionControllerDeps {
  return { ...deps, connectSerialPort: registry.recording(deps.connectSerialPort), localOutputs: registry.outputs };
}
