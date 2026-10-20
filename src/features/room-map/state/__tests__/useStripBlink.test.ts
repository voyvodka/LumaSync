import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FlashDeps } from "@/features/device/state/stripFlash";
import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { LedStrip } from "@/shared/contracts/strips";

import { useStripBlink } from "../useStripBlink";

const stored = vi.hoisted(() => ({ strips: [] as unknown[], fail: false }));
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: async () => (stored.fail ? Promise.reject(new Error("no disk")) : { ledStrips: stored.strips }) },
}));
vi.mock("@/features/strips/model/stripSelectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/strips/model/stripSelectors")>()),
  stripsOf: () => stored.strips,
}));

const layout = (top: number): LedCalibrationConfig => ({
  counts: { top, right: 0, bottom: 0, left: 0 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "subtle",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: top,
});
const strip = (id: string, port: string, top: number): LedStrip => ({
  id,
  enabled: true,
  transport: { kind: "serial", portName: port },
  hardware: {} as LedStrip["hardware"],
  layout: layout(top),
});

const deps = (previewOnly = false, active = true) => {
  const start = vi.fn<FlashDeps["start"]>(async () => ({ active, previewOnly, status: { code: "LED_TEST_PATTERN_STARTED" } }) as never);
  return { start, stop: vi.fn<FlashDeps["stop"]>(async () => ({}) as never), wait: async () => {} };
};

beforeEach(() => {
  stored.strips = [strip("a", "COM1", 30), strip("b", "COM3", 90)];
  stored.fail = false;
});

describe("useStripBlink", () => {
  it("flashes with the layout of the strip on the light's port", async () => {
    const d = deps();
    const { result } = renderHook(() => useStripBlink(d));
    await act(() => result.current.blink("usb-s1", "COM3"));
    expect(d.start.mock.calls[0]![0].ledCalibration?.totalLeds).toBe(90);
    expect(result.current.failure).toBeNull();
    expect(result.current.busyId).toBeNull();
  });

  it("falls back to the first strip enabled when no strip is on that port", async () => {
    const d = deps();
    const { result } = renderHook(() => useStripBlink(d));
    await act(() => result.current.blink("tv", null));
    expect(d.start.mock.calls[0]![0].ledCalibration?.totalLeds).toBe(30);
  });

  it("says when the flash reached only the preview, could not start, or the strips could not be read", async () => {
    const preview = renderHook(() => useStripBlink(deps(true)));
    await act(() => preview.result.current.blink("usb-s1", "COM3"));
    expect(preview.result.current.failure).toEqual({ id: "usb-s1", outcome: "notSent" });

    const refused = renderHook(() => useStripBlink(deps(false, false)));
    await act(() => refused.result.current.blink("tv", "COM3"));
    expect(refused.result.current.failure).toEqual({ id: "tv", outcome: "failed" });

    stored.fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unread = renderHook(() => useStripBlink(deps()));
    await act(() => unread.result.current.blink("tv", "COM3"));
    expect(unread.result.current.failure).toEqual({ id: "tv", outcome: "failed" });
    spy.mockRestore();
  });
});
