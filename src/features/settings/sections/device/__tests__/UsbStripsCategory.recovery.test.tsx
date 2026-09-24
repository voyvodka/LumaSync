// Auto-recovery on Devices → USB, through a real connection controller and the
// real invoke bridge. The reconnecting copy says the user can press Connect at
// any time; the page had disabled every Connect for as long as recovery ran,
// and the "recovery stopped" hint the takeover mints was wiped before it showed.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import {
  connectSerialPort,
  getSerialConnectionStatus,
  listSerialPorts,
  runSerialHealthCheck,
  type SerialConnectionStatus,
  type SerialPortListResponse,
} from "@/features/device/deviceConnectionApi";
import { createDeviceConnectionController } from "@/features/device/state/deviceConnectionController";
import type { DeviceConnectionController } from "@/features/device/state/connectionTypes";
import type { UseDeviceConnectionResult } from "@/features/device/useDeviceConnection";
import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import type { ShellState } from "@/shared/contracts/shell";
import { invokeFromCommands } from "@/test/mockCommands";

import { UsbStripsCategory } from "../UsbStripsCategory";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn<typeof invoke>() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { stateRef } = vi.hoisted(() => ({ stateRef: { current: {} as Partial<ShellState> } }));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(stateRef.current),
    save: (partial: Partial<ShellState>) => {
      stateRef.current = { ...stateRef.current, ...partial };
      return Promise.resolve();
    },
    update: (fn: (current: ShellState) => Partial<ShellState> | null) => {
      const partial = fn(stateRef.current as ShellState);
      if (partial) stateRef.current = { ...stateRef.current, ...partial };
      return Promise.resolve(stateRef.current);
    },
  },
}));

// Their own store and IPC reads are not what this test is about.
vi.mock("../../control/LedChipTypePicker", () => ({ LedChipTypePicker: () => null }));
vi.mock("../../control/LedColorOrderControl", () => ({ LedColorOrderControl: () => null }));
vi.mock("../../control/FirmwareProfilePicker", () => ({ FirmwareProfilePicker: () => null }));

const OLD_PORT = "/dev/cu.usbserial-110";
const NEW_PORT = "/dev/cu.usbserial-220";

function port(name: string): SerialPortListResponse["ports"][number] {
  return {
    name,
    kind: "usb",
    isSupported: true,
    supportReason: "Supported USB serial adapter",
    usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
  };
}

function connected(portName: string | null): SerialConnectionStatus {
  return {
    portName,
    connected: portName !== null,
    status: { code: portName ? "CONNECT_OK" : "NOT_CONNECTED", message: "m", details: null },
    updatedAtUnixMs: 0,
  };
}

let visible: string[];
let rustConnected: string | null;
let finishConnect: ((status: SerialConnectionStatus) => void) | null;
let controller: DeviceConnectionController;

beforeEach(() => {
  stateRef.current = {};
  visible = [OLD_PORT, NEW_PORT];
  rustConnected = OLD_PORT;
  finishConnect = null;
  vi.mocked(invoke).mockImplementation(
    invokeFromCommands({
      list_serial_ports: () => ({
        status: { code: "LIST_PORTS_OK", message: "ok", details: null },
        ports: visible.map(port),
      }),
      get_serial_connection_status: () => connected(rustConnected),
      // Held open so the page can be read while the connect runs.
      connect_serial_port: () =>
        new Promise<SerialConnectionStatus>((resolve) => {
          finishConnect = resolve;
        }),
    }),
  );
  controller = createDeviceConnectionController({
    listSerialPorts,
    connectSerialPort: (portName) => connectSerialPort(portName),
    getSerialConnectionStatus,
    runSerialHealthCheck,
    persistLastSuccessfulPort: () => Promise.resolve(),
    refreshVisibleWaitMs: 0,
    refreshMinIntervalMs: 0,
    // Recovery stays in its retry wait for the whole test: what is under test
    // is the page while it runs, not a retry.
    recoveryFastDelayMs: 60_000,
  });
});

afterEach(() => {
  controller.dispose();
});

/** The page wired to a live controller, as DeviceSection does through the hook. */
function Page({ source }: { source: DeviceConnectionController }) {
  const [state, setState] = useState(source.getState());
  const [pairedStrips, setPairedStrips] = useState<UsbStripPlacement[]>([]);
  useEffect(() => source.subscribe(setState), [source]);
  const device: UseDeviceConnectionResult = {
    ...state,
    isConnected: state.connectedPort !== null,
    refreshPorts: source.refreshPorts,
    selectPort: source.selectPort,
    connectSelectedPort: source.connectSelectedPort,
    runHealthCheck: source.runHealthCheck,
  };
  return (
    <UsbStripsCategory
      isActive
      device={device}
      pairedStrips={pairedStrips}
      setPairedStrips={setPairedStrips}
      persistError={false}
      flagPersistError={() => {}}
      clearPersistError={() => {}}
    />
  );
}

async function unplugDuringUse() {
  render(<Page source={controller} />);
  await act(() => controller.initialize());
  expect(controller.getState().connectedPort).toBe(OLD_PORT);

  visible = [NEW_PORT];
  rustConnected = null;
  await userEvent.setup().click(screen.getAllByRole("button", { name: "device:page.actions.rescan" })[0]);
  await waitFor(() => expect(controller.getState().isReconnecting).toBe(true));
  expect(within(screen.getByTestId("usb-status")).getByText("device:status.reconnectingTitle")).toBeInTheDocument();
}

it("lets the user press Connect while auto-recovery runs, and takes over from it", async () => {
  await unplugDuringUse();

  const connect = screen.getByRole("button", { name: "device:page.usb.connect" });
  expect(connect).toBeEnabled();
  await userEvent.setup().click(connect);

  expect(controller.getState().isReconnecting).toBe(false);
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("connect_serial_port", expect.objectContaining({ portName: NEW_PORT }));

  await act(async () => {
    rustConnected = NEW_PORT;
    finishConnect?.(connected(NEW_PORT));
  });
  await waitFor(() => expect(controller.getState().connectedPort).toBe(NEW_PORT));
  expect(within(screen.getByTestId("usb-status")).getByText("device:status.connectedTitle")).toBeInTheDocument();
});

it("says auto-recovery stopped while the user's connect runs", async () => {
  await unplugDuringUse();

  await userEvent.setup().click(screen.getByRole("button", { name: "device:page.usb.connect" }));

  const status = screen.getByTestId("usb-status");
  expect(within(status).getByText("device:status.connectingTitle")).toBeInTheDocument();
  expect(within(status).getByText("device:status.hints.recoveryCancelled")).toBeInTheDocument();

  await act(async () => {
    finishConnect?.(connected(NEW_PORT));
  });
});
