import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StartLedTestPatternPayload } from "@/shared/contracts/preview";

vi.mock("@/features/preview/previewApi", () => ({ startLedTestPattern: async () => ({}), stopLedTestPattern: async () => ({}) }));

import { FLASH_FALLBACK_LAYOUT, FLASH_MS, flashStrip, markStripLit, useStripUnlit, type FlashDeps } from "../stripFlash";

function deps(started: { active: boolean; previewOnly?: boolean }) {
  const calls: string[] = [];
  const payloads: StartLedTestPatternPayload[] = [];
  const d = {
    start: vi.fn<FlashDeps["start"]>(async (payload: StartLedTestPatternPayload) => {
      calls.push("start");
      payloads.push(payload);
      return { active: started.active, previewOnly: started.previewOnly ?? false } as never;
    }),
    stop: vi.fn<FlashDeps["stop"]>(async () => {
      calls.push("stop");
      return {} as never;
    }),
    wait: vi.fn<FlashDeps["wait"]>(async (ms: number) => {
      calls.push(`wait ${ms}`);
    }),
  } satisfies FlashDeps;
  return { d, calls, payloads };
}

describe("flashStrip", () => {
  it("lights the strip white on USB, holds, lets go, and says it lit", async () => {
    const { d, calls, payloads } = deps({ active: true });
    const layout = { ...FLASH_FALLBACK_LAYOUT, totalLeds: 90 };
    expect(await flashStrip(layout, d)).toBe("lit");
    expect(calls).toEqual(["start", `wait ${FLASH_MS}`, "stop"]);
    expect(payloads[0]).toMatchObject({ pattern: { kind: "solid", r: 255, g: 255, b: 255 }, targets: ["usb"], ledCalibration: layout });
  });

  // Without a layout the pattern runs on the preview only, and the strip never lights.
  it("a strip with no layout flashes sixty LEDs along one edge", async () => {
    const { d, payloads } = deps({ active: true });
    await flashStrip(undefined, d);
    expect(payloads[0]?.ledCalibration).toBe(FLASH_FALLBACK_LAYOUT);
  });

  it("a flash that reached only the preview is not asked about", async () => {
    const { d, calls } = deps({ active: true, previewOnly: true });
    expect(await flashStrip(undefined, d)).toBe("notSent");
    expect(calls).toContain("stop");
  });

  it("a flash that could not start changes nothing and has nothing to stop", async () => {
    const { d, calls } = deps({ active: false });
    expect(await flashStrip(undefined, d)).toBe("failed");
    expect(calls).toEqual(["start"]);
  });
});

describe("the strips that did not light", () => {
  it("are remembered per strip until one lights", () => {
    const { result } = renderHook(() => ({ a: useStripUnlit("flash-a"), b: useStripUnlit("flash-b") }));
    expect(result.current).toEqual({ a: false, b: false });
    act(() => markStripLit("flash-a", false));
    expect(result.current).toEqual({ a: true, b: false });
    act(() => markStripLit("flash-a", true));
    expect(result.current).toEqual({ a: false, b: false });
  });
});
