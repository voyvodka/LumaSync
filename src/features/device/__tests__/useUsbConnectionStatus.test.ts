/**
 * useUsbConnectionStatus — connection-events bus subscription contract.
 *
 * The hook is consumed by the room-map editor (badge on every USB
 * strip) and the UsbStripInspector (live ONLINE/OFFLINE chip). Both
 * surfaces rely on:
 *   1. an initial Rust snapshot resolved on mount,
 *   2. re-syncing whenever any other controller emits a
 *      `connectionEvents` change,
 *   3. cleaning up the bus subscription on unmount so a tree teardown
 *      cannot leak listeners across the SPA's lifetime.
 *
 * These tests assert each contract in isolation by feeding the hook a
 * synthetic bus + status fetcher (no Tauri bridge).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createConnectionEventBus } from "../connectionEvents";
import type { SerialConnectionStatus } from "../deviceConnectionApi";
import { useUsbConnectionStatus } from "../useUsbConnectionStatus";

function makeStatus(portName: string | null): SerialConnectionStatus {
  return {
    portName,
    connected: portName !== null,
    status: { code: "OK", message: "ok" },
    updatedAtUnixMs: Date.now(),
  };
}

describe("useUsbConnectionStatus", () => {
  it("hydrates the initial snapshot from getStatus and flips ready=true", async () => {
    const bus = createConnectionEventBus();
    const fetcher = vi.fn().mockResolvedValue(makeStatus("/dev/ttyUSB0"));

    const { result } = renderHook(() =>
      useUsbConnectionStatus({ connectionEvents: bus, getStatus: fetcher }),
    );

    expect(result.current).toEqual({ connectedPort: null, ready: false });

    await waitFor(() => {
      expect(result.current).toEqual({
        connectedPort: "/dev/ttyUSB0",
        ready: true,
      });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches whenever the connectionEvents bus emits a change", async () => {
    const bus = createConnectionEventBus();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(makeStatus(null))
      .mockResolvedValueOnce(makeStatus("/dev/ttyUSB1"));

    const { result } = renderHook(() =>
      useUsbConnectionStatus({ connectionEvents: bus, getStatus: fetcher }),
    );

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.connectedPort).toBe(null);

    await act(async () => {
      bus.emit({ portName: "/dev/ttyUSB1", connected: true });
    });

    await waitFor(() => {
      expect(result.current.connectedPort).toBe("/dev/ttyUSB1");
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("flips ready=true even when getStatus rejects (silent-catch ban)", async () => {
    const bus = createConnectionEventBus();
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useUsbConnectionStatus({ connectionEvents: bus, getStatus: fetcher }),
    );

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.connectedPort).toBe(null);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] useUsbConnectionStatus fetch failed"),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("unsubscribes from the bus on unmount", async () => {
    const bus = createConnectionEventBus();
    // Spy on the bus.subscribe contract to confirm the dispose is
    // invoked once the React tree unmounts.
    const dispose = vi.fn();
    const realSubscribe = bus.subscribe.bind(bus);
    bus.subscribe = (listener) => {
      const inner = realSubscribe(listener);
      return () => {
        dispose();
        inner();
      };
    };
    const fetcher = vi.fn().mockResolvedValue(makeStatus(null));

    const { unmount, result } = renderHook(() =>
      useUsbConnectionStatus({ connectionEvents: bus, getStatus: fetcher }),
    );

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
