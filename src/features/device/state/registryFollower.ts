import { DEVICE_OPERATION, DEVICE_STATUS, SERIAL_CONNECT_STATUS } from "@/shared/contracts/device";

import { connectedSerialPort, serialEntry } from "../model/localOutputs";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState, toOutputCard } from "./connectionStateHelpers";
import type { LocalOutputs, LocalOutputsState } from "./localOutputsStore";

export interface RegistryFollower {
  /** Follows Rust's events until `stop`. */
  start(): void;
  /** Reads the registry and applies it: at initialize, and after a command that changed it. */
  sync(): Promise<void>;
  stop(): void;
}

/**
 * The controller's `connectedPort` as Rust's local-output registry says it, never as a command's
 * answer guessed it: every mount reads the same facts, so a connect, an unplug or a strip let go of
 * reaches all of them without them telling each other.
 */
export function createRegistryFollower(store: ConnectionStore, outputs: LocalOutputs): RegistryFollower {
  let unsubscribe: (() => void) | null = null;
  let release: (() => void) | null = null;

  const apply = ({ snapshot }: LocalOutputsState) => {
    if (snapshot === null || store.isDisposed()) return;
    const prev = store.getState();
    // A running operation owns `status`; the connection itself is still Rust's.
    const idle = prev.activeOperation === DEVICE_OPERATION.IDLE;
    const port = connectedSerialPort(snapshot);

    if (port !== null) {
      if (prev.connectedPort === port) return;
      const entry = serialEntry(snapshot, port);
      store.setState((state) => ({
        ...state,
        status: idle ? DEVICE_STATUS.CONNECTED : state.status,
        connectedPort: port,
        selectedPort: state.selectedPort ?? port,
        lastSuccessfulPort: port,
        statusCard: entry ? toOutputCard(entry) : state.statusCard,
      }));
      return;
    }

    if (prev.connectedPort !== null) {
      const entry = serialEntry(snapshot, prev.connectedPort);
      store.setState((state) => ({
        ...state,
        status: idle ? nextStatusForReadyState(state.ports) : state.status,
        connectedPort: null,
        statusCard: entry ? toOutputCard(entry) : null,
      }));
      return;
    }

    // Another mount's reconnect met a wedged driver; this one shows it too.
    const candidate = prev.selectedPort ?? prev.lastSuccessfulPort;
    const entry = candidate ? serialEntry(snapshot, candidate) : null;
    if (entry?.status.code === SERIAL_CONNECT_STATUS.REPLUG_REQUIRED && prev.statusCard?.code !== entry.status.code) {
      store.setState((state) => ({ ...state, statusCard: toOutputCard(entry) }));
    }
  };

  return {
    start() {
      if (release !== null) return;
      release = outputs.start();
      unsubscribe = outputs.store.subscribe(() => apply(outputs.store.get()));
    },
    async sync() {
      await outputs.refresh();
      apply(outputs.store.get());
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      release?.();
      release = null;
    },
  };
}
