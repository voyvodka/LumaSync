// Under StrictMode React mounts, unmounts and remounts every effect once. The
// hook used to hold its controller in a memo, so the rehearsal unmount disposed
// the only instance; with no saved port nothing re-created it. The shell's copy
// then stopped following, and the status bar read "USB OFF" beside a strip the
// Devices page had just connected.

import { invoke } from "@tauri-apps/api/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalOutputsSnapshot, SerialConnectionStatus } from "@/shared/contracts/device";
import type { ShellState } from "@/shared/contracts/shell";
import { withSerialTransport } from "@/features/strips/model/stripWrites";
import { invokeFromCommands } from "@/test/mockCommands";

import { useDeviceConnection } from "../useDeviceConnection";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn<typeof invoke>(),
}));

const { saved } = vi.hoisted(() => ({ saved: { current: {} as Partial<ShellState> } }));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(saved.current),
    save: () => Promise.resolve(),
    update: () => Promise.resolve(saved.current),
  },
}));

const PORT = "/dev/cu.usbserial-1420";

let connectedPort: string | null = null;
// The registry store is the app's one instance, so its revision only grows across tests.
let revision = 100;

function status(): SerialConnectionStatus {
  return { portName: connectedPort, connected: true, status: { code: "CONNECT_OK", message: "ok", details: null }, updatedAtUnixMs: 0 };
}

function registry(): LocalOutputsSnapshot {
  return {
    revision,
    outputs: connectedPort
      ? [{ kind: "serial", portName: connectedPort, connected: true, status: status().status, firmware: null, updatedAtUnixMs: 0 }]
      : [],
    driven: connectedPort ? { kind: "serial", portName: connectedPort } : null,
  };
}

let finishConnect: (() => void) | null = null;
let holdConnects = false;

beforeEach(() => {
  connectedPort = null;
  revision += 1;
  saved.current = {};
  holdConnects = false;
  finishConnect = null;
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
      get_local_outputs: () => registry(),
      connect_serial_port: ({ portName }) => {
        const done = () => {
          connectedPort = portName;
          revision += 1;
          return status();
        };
        if (!holdConnects) return done();
        return new Promise<SerialConnectionStatus>((resolve) => {
          finishConnect = () => resolve(done());
        });
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

const connects = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "connect_serial_port");

describe("one reconnect at launch", () => {
  beforeEach(() => {
    saved.current = { ...withSerialTransport({} as ShellState, PORT) };
  });

  // The Devices page used to try the saved port at the same moment as the shell.
  it("comes from the mount that owns reconnects, not from every mount", async () => {
    const { result } = renderHook(() => ({
      shell: useDeviceConnection({ ownsReconnects: true }),
      page: useDeviceConnection(),
    }));

    await waitFor(() => expect(result.current.shell.isConnected).toBe(true));
    await waitFor(() => expect(result.current.page.isConnected).toBe(true));
    expect(connects()).toHaveLength(1);
  });

  it("happens once under StrictMode's rehearsal mount", async () => {
    const { result } = renderHook(() => useDeviceConnection({ ownsReconnects: true }), { wrapper: StrictMode });

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(connects()).toHaveLength(1);
  });

  it("a page mount alone does not connect the saved strip", async () => {
    const { result } = renderHook(() => useDeviceConnection());

    await waitFor(() => expect(result.current.ports).toHaveLength(1));
    expect(connects()).toHaveLength(0);
  });
});

describe("two connects of one port", () => {
  // A second open of a port being opened fails on the OS lock; Rust would record that against a strip that is fine.
  it("share one attempt", async () => {
    holdConnects = true;
    const { result } = renderHook(() => ({ shell: useDeviceConnection(), page: useDeviceConnection() }));
    await waitFor(() => expect(result.current.page.ports).toHaveLength(1));
    act(() => {
      result.current.shell.selectPort(PORT);
      result.current.page.selectPort(PORT);
    });

    let both: Promise<[boolean, boolean]> = Promise.resolve([false, false]);
    act(() => {
      both = Promise.all([result.current.shell.connectSelectedPort(), result.current.page.connectSelectedPort()]);
    });
    await waitFor(() => expect(finishConnect).not.toBeNull());
    await act(async () => {
      finishConnect?.();
      await both;
    });

    expect(connects()).toHaveLength(1);
    await expect(both).resolves.toEqual([true, true]);
  });
});
