// Under StrictMode React mounts, unmounts and remounts every effect once. The
// hook used to hold its controller in a memo, so the rehearsal unmount disposed
// the only instance; with no saved port nothing re-created it. The shell's copy
// then never heard its siblings, and the status bar read "USB OFF" beside a
// strip the Devices page had just connected.

import { invoke } from "@tauri-apps/api/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SerialConnectionStatus } from "@/shared/contracts/device";
import { invokeFromCommands } from "@/test/mockCommands";

import { useDeviceConnection } from "../useDeviceConnection";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn<typeof invoke>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
  },
}));

const PORT = "/dev/cu.usbserial-1420";

let connectedPort: string | null = null;

function status(): SerialConnectionStatus {
  return connectedPort
    ? { portName: connectedPort, connected: true, status: { code: "CONNECT_OK", message: "ok", details: null }, updatedAtUnixMs: 0 }
    : { portName: null, connected: false, status: { code: "NOT_CONNECTED", message: "idle", details: null }, updatedAtUnixMs: 0 };
}

beforeEach(() => {
  connectedPort = null;
  vi.mocked(invoke).mockImplementation(
    invokeFromCommands({
      list_serial_ports: {
        status: { code: "LIST_PORTS_OK", message: "ok", details: null },
        ports: [
          {
            name: PORT,
            kind: "usb",
            isSupported: true,
            supportReason: "PORT_SUPPORTED",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
        ],
      },
      get_serial_connection_status: () => status(),
      connect_serial_port: ({ portName }) => {
        connectedPort = portName;
        return status();
      },
    }),
  );
});

describe("useDeviceConnection under StrictMode", () => {
  it("keeps a second mount in step with a connect made through the first", async () => {
    // The shell and the Devices page each mount the hook.
    const { result } = renderHook(
      () => ({ shell: useDeviceConnection(), page: useDeviceConnection() }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.page.ports).toHaveLength(1));

    act(() => result.current.page.selectPort(PORT));
    let connected = false;
    await act(async () => {
      connected = await result.current.page.connectSelectedPort();
    });

    expect(connected).toBe(true);
    expect(result.current.page.connectedPort).toBe(PORT);
    await waitFor(() => expect(result.current.shell.isConnected).toBe(true));
  });
});
