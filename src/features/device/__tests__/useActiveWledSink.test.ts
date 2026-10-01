import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LocalOutputsSnapshot } from "@/shared/contracts/device";
import type { shellStore as shellStoreType } from "@/features/persistence/shellStore";

const loadMock = vi.fn<typeof shellStoreType.load>();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => loadMock(),
    save: vi.fn<typeof shellStoreType.save>(),
    update: vi.fn<typeof shellStoreType.update>().mockResolvedValue({} as Awaited<ReturnType<typeof shellStoreType.update>>),
  },
}));

import { createLocalOutputs } from "../state/localOutputsStore";
import { useActiveWledSink } from "../useWledSink";

function registry(snapshot: LocalOutputsSnapshot) {
  const read = vi.fn<() => Promise<LocalOutputsSnapshot>>(async () => snapshot);
  return { read, outputs: createLocalOutputs({ read, listen: async () => () => {} }) };
}

const wledBound: LocalOutputsSnapshot = {
  revision: 1,
  outputs: [{ kind: "wled", ip: "192.168.1.42", ledCount: 60, connected: true, reachable: true }],
  driven: { kind: "wled", ip: "192.168.1.42" },
};

describe("useActiveWledSink", () => {
  // A default dependency rebuilt per render re-ran the refresh effect on every
  // render of App, reading the shell state and the registry each time.
  it("reads once on mount, not again on every render", async () => {
    loadMock.mockResolvedValue({} as Awaited<ReturnType<typeof shellStoreType.load>>);
    const { read, outputs } = registry(wledBound);

    const { rerender } = renderHook(() => useActiveWledSink({ localOutputs: outputs }));
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
    rerender();
    rerender();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadMock).toHaveBeenCalledTimes(1);
    // One read from starting the store, one from the hook's own refresh.
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("names the bound device from the registry, and follows it when it goes", async () => {
    loadMock.mockResolvedValue({} as Awaited<ReturnType<typeof shellStoreType.load>>);
    const { outputs } = registry(wledBound);

    const { result } = renderHook(() => useActiveWledSink({ localOutputs: outputs }));
    await waitFor(() => expect(result.current.activeWledIp).toBe("192.168.1.42"));

    act(() => {
      outputs.ingest({ revision: 2, outputs: [], driven: null });
    });
    expect(result.current.activeWledIp).toBeNull();
  });

  // One output at a time, as the user sees it, while Rust could drive several.
  it("lets the strips go once the user's WLED device is connected and saved", async () => {
    loadMock.mockResolvedValue({} as Awaited<ReturnType<typeof shellStoreType.load>>);
    const { outputs } = registry(wledBound);
    const releaseOthers = vi.fn<(kept: { kind: "wled"; ip: string } | { kind: "serial"; portName: string }) => Promise<void>>()
      .mockResolvedValue();
    const updateShellState = vi.fn<NonNullable<Parameters<typeof useActiveWledSink>[0]>["updateShellState"] & {}>()
      .mockResolvedValue({} as Awaited<ReturnType<typeof shellStoreType.update>>);

    const { result } = renderHook(() => useActiveWledSink({ localOutputs: outputs, releaseOthers, updateShellState }));
    await act(async () => {
      await result.current.markConnected({ ip: "192.168.1.42", mac: null, ledCount: 60, name: null, version: null });
    });

    expect(releaseOthers).toHaveBeenCalledWith({ kind: "wled", ip: "192.168.1.42" });
    expect(updateShellState.mock.invocationCallOrder[0]).toBeLessThan(releaseOthers.mock.invocationCallOrder[0]!);
  });
});
