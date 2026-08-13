import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";
import { createWledSinkEventBus } from "../wledSinkEvents";
import { resetWledRestoreGuard, useWledSinkRestore } from "../useWledSink";

const SAVED = {
  ip: "192.168.1.42",
  port: 4048,
  ledCount: 60,
  protocol: "ddp" as const,
};

function buildDeps() {
  return {
    wledSinkEvents: createWledSinkEventBus(),
    loadShellState: vi
      .fn()
      .mockResolvedValue({ lastWledSink: SAVED } as unknown as ShellState),
    saveShellState: vi.fn().mockResolvedValue(undefined),
    discover: vi.fn().mockResolvedValue({
      status: { code: "WLED_DISCOVERY_OK", message: "ok", details: null },
      devices: [{ ip: SAVED.ip, ledCount: 60 }],
    }),
    connect: vi.fn().mockResolvedValue({
      status: { code: "WLED_CONNECT_OK", message: "ok", details: null },
    }),
  };
}

beforeEach(() => {
  resetWledRestoreGuard();
});

describe("useWledSinkRestore", () => {
  it("publishes the restore outcome on the injected bus", async () => {
    const deps = buildDeps();

    renderHook(() => useWledSinkRestore(deps));

    await waitFor(() => {
      expect(deps.wledSinkEvents.latest().kind).toBe("restored");
    });
  });

  // StrictMode double-mounts every effect in dev; without the module-level
  // guard that is two probes and two connects on every launch.
  it("probes once even when the effect runs twice", async () => {
    const deps = buildDeps();

    const { unmount } = renderHook(() => useWledSinkRestore(deps));
    unmount();
    renderHook(() => useWledSinkRestore(deps));

    await waitFor(() => {
      expect(deps.connect).toHaveBeenCalled();
    });
    expect(deps.discover).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });
});
