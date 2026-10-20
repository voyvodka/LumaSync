import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LocalOutputsSnapshot } from "@/shared/contracts/device";

import { useUsbStripStatus } from "../useUsbStripStatus";

const registry = vi.hoisted(() => ({ snapshot: null as LocalOutputsSnapshot | null }));

vi.mock("@/features/device/state/localOutputsStore", () => ({
  useLocalOutputs: <S>(select: (state: { snapshot: LocalOutputsSnapshot | null; lastLoss: null }) => S) =>
    select({ snapshot: registry.snapshot, lastLoss: null }),
}));

const strip = { stripId: "s", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 30 };

describe("useUsbStripStatus", () => {
  it("reads a strip that names no port as unlinked, even with a controller connected", () => {
    registry.snapshot = { driven: { kind: "serial", portName: "COM3" }, outputs: [] } as unknown as LocalOutputsSnapshot;
    const { result } = renderHook(() => useUsbStripStatus(undefined));
    expect(result.current.stripStatus(strip)).toEqual({ status: "unlinked", port: null });
    expect(result.current.stripStatus({ ...strip, portName: "COM3" })).toEqual({ status: "connected", port: "COM3" });
    expect(result.current.stripStatus({ ...strip, portName: "COM4" })).toEqual({ status: "disconnected", port: "COM4" });
  });

  it("knows a portless strip is unlinked before the registry answers", () => {
    registry.snapshot = null;
    const { result } = renderHook(() => useUsbStripStatus(undefined));
    expect(result.current.stripStatus(strip).status).toBe("unlinked");
    expect(result.current.stripStatus({ ...strip, portName: "COM3" }).status).toBe("unknown");
  });
});
