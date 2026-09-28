// Rust sends the registry's events outside its lock, so they can arrive out of order: a reader
// keeps the newest it has seen. And the listener goes up before the first read, so a change landing
// between the two is never lost.

import { describe, expect, it, vi } from "vitest";

import type { LocalOutputsSnapshot } from "@/shared/contracts/device";

import { createLocalOutputs, type LocalOutputsDeps } from "../localOutputsStore";

const snap = (revision: number, ip: string | null = null): LocalOutputsSnapshot => ({
  revision,
  outputs: ip === null ? [] : [{ kind: "wled", ip, ledCount: 60, connected: true }],
  driven: ip === null ? null : { kind: "wled", ip },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("localOutputs store", () => {
  it("drops a snapshot that is not newer than the one held", () => {
    const outputs = createLocalOutputs({ read: async () => snap(0), listen: async () => () => {} });
    expect(outputs.ingest(snap(5, "10.0.0.5"))).toBe(true);
    expect(outputs.ingest(snap(3, "10.0.0.3"))).toBe(false);
    expect(outputs.ingest(snap(5, "10.0.0.9"))).toBe(false);
    expect(outputs.store.get().snapshot?.driven).toEqual({ kind: "wled", ip: "10.0.0.5" });
  });

  // The reconciler drops "usb" on an unplug only; a later change that loses nothing keeps the answer.
  it("remembers how the last output went until another one goes", () => {
    const outputs = createLocalOutputs({ read: async () => snap(0), listen: async () => () => {} });
    const serial = (revision: number, connected: boolean, code: "CONNECT_OK" | "PORT_NOT_FOUND" | "DISCONNECTED") => ({
      revision,
      outputs: [
        {
          kind: "serial" as const,
          portName: "COM3",
          connected,
          status: { code, message: code, details: null },
          firmware: null,
          updatedAtUnixMs: 0,
        },
      ],
      driven: null,
    });

    outputs.ingest(serial(1, true, "CONNECT_OK"));
    expect(outputs.store.get().lastLoss).toBeNull();
    outputs.ingest(serial(2, false, "PORT_NOT_FOUND"));
    expect(outputs.store.get().lastLoss).toBe("unplugged");
    outputs.ingest(snap(3, "10.0.0.5"));
    expect(outputs.store.get().lastLoss).toBe("unplugged");
    outputs.ingest(snap(4));
    expect(outputs.store.get().lastLoss).toBe("released");
  });

  it("takes the first snapshot whatever its revision", () => {
    const outputs = createLocalOutputs({ read: async () => snap(0), listen: async () => () => {} });
    expect(outputs.ingest(snap(0))).toBe(true);
    expect(outputs.store.get().snapshot?.revision).toBe(0);
  });

  it("reads only once the listener is up, and keeps an event that lands while the first read is in flight", async () => {
    const read = deferred<LocalOutputsSnapshot>();
    const readCalls = vi.fn<() => Promise<LocalOutputsSnapshot>>(() => read.promise);
    // Registering a Tauri listener is itself asynchronous.
    const registered = deferred<void>();
    let emit: (snapshot: LocalOutputsSnapshot) => void = () => {};
    const outputs = createLocalOutputs({
      read: readCalls,
      listen: async (handler) => {
        await registered.promise;
        emit = handler;
        return () => {};
      },
    });

    outputs.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(readCalls).not.toHaveBeenCalled();

    registered.resolve();
    await vi.waitFor(() => expect(readCalls).toHaveBeenCalledTimes(1));
    // A WLED bind announced while the read was on its way, with the older answer arriving after it.
    emit(snap(2, "10.0.0.2"));
    read.resolve(snap(1));
    await vi.waitFor(() => expect(outputs.store.get().snapshot?.revision).toBe(2));
    expect(outputs.store.get().snapshot?.driven).toEqual({ kind: "wled", ip: "10.0.0.2" });
  });

  it("shares one listener between holders and stops it with the last", async () => {
    const stop = vi.fn<() => void>();
    const listen = vi.fn<LocalOutputsDeps["listen"]>(async () => stop);
    const outputs = createLocalOutputs({ read: async () => snap(1), listen });

    const first = outputs.start();
    const second = outputs.start();
    first();
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    second();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("keeps what it has when a read fails", async () => {
    const outputs = createLocalOutputs({
      read: async () => {
        throw new Error("IPC closed");
      },
      listen: async () => () => {},
    });
    outputs.ingest(snap(4, "10.0.0.4"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(outputs.refresh()).resolves.toMatchObject({ revision: 4 });
  });

  it("follows again after the last holder stopped and a new one starts", async () => {
    const listen = vi.fn<LocalOutputsDeps["listen"]>(async () => () => {});
    const read = vi.fn<() => Promise<LocalOutputsSnapshot>>(async () => snap(1));
    const outputs = createLocalOutputs({ read, listen });

    outputs.start()();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    outputs.start();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
