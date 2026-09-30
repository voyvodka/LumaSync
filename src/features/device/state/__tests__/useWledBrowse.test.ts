import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WledDiscoveryResponse } from "@/shared/contracts/device";

import { useWledBrowse } from "../useWledBrowse";

const ok = (...ips: string[]): WledDiscoveryResponse => ({
  status: { code: "WLED_BROWSE_OK", message: "ok", details: null },
  devices: ips.map((ip) => ({ ip, ledCount: 30 })),
});

describe("useWledBrowse", () => {
  it("pages open during a browse share it, and each opening after it browses again", async () => {
    let answer: (found: WledDiscoveryResponse) => void = () => {};
    const browse = vi.fn<() => Promise<WledDiscoveryResponse>>(() => new Promise((resolve) => (answer = resolve)));
    const first = renderHook(({ active }) => useWledBrowse(active, browse), { initialProps: { active: true } });
    const second = renderHook(() => useWledBrowse(true, browse));
    expect(browse).toHaveBeenCalledTimes(1);
    expect(first.result.current.browsing).toBe(true);

    await act(async () => answer(ok("10.0.0.5")));
    expect(first.result.current).toEqual({ browsing: false, devices: [{ ip: "10.0.0.5", ledCount: 30 }] });
    expect(second.result.current.devices).toHaveLength(1);

    first.rerender({ active: false });
    first.rerender({ active: true });
    expect(browse).toHaveBeenCalledTimes(2);
    // The shared browse is module state: it ends here, not in the next test.
    await act(async () => answer(ok()));
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("ipc"))],
    [
      "throws",
      () => {
        throw new Error("no such export");
      },
    ],
  ])("does not browse while inactive, and a browse that %s ends with nothing found", async (_, fails) => {
    const browse = vi.fn<() => Promise<WledDiscoveryResponse>>(fails);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = renderHook(({ active }) => useWledBrowse(active, browse), { initialProps: { active: false } });
    expect(browse).not.toHaveBeenCalled();

    hook.rerender({ active: true });
    await act(async () => {});
    expect(hook.result.current).toEqual({ browsing: false, devices: [] });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
