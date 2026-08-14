import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { toHueStartConfig } from "../../model/hueStartConfig";
import { useStableHueStartConfig } from "../useStableHueStartConfig";

const shellState = {
  lastHueBridge: { ip: "192.168.1.10" },
  hueAppKey: "app-user",
  hueClientKey: "AABBCCDD",
  lastHueAreaId: "area-1",
};

describe("useStableHueStartConfig", () => {
  it("keeps the same reference when the projected values are unchanged", () => {
    const { result } = renderHook(() => useStableHueStartConfig());

    act(() => result.current[1](toHueStartConfig(shellState)));
    const first = result.current[0];

    // What a mode change does: re-project unchanged shell state. Every effect
    // keyed on this config restarts if the reference moves.
    act(() => result.current[1](toHueStartConfig(shellState)));
    act(() => result.current[1](toHueStartConfig(shellState)));

    expect(result.current[0]).toBe(first);
  });

  it("adopts a genuinely different config", () => {
    const { result } = renderHook(() => useStableHueStartConfig());

    act(() => result.current[1](toHueStartConfig(shellState)));
    const first = result.current[0];

    act(() => result.current[1](toHueStartConfig({ ...shellState, lastHueAreaId: "area-2" })));

    expect(result.current[0]).not.toBe(first);
    expect(result.current[0]?.areaId).toBe("area-2");
  });

  it("moves to and from the unpaired null", () => {
    const { result } = renderHook(() => useStableHueStartConfig());

    expect(result.current[0]).toBeNull();
    act(() => result.current[1](toHueStartConfig(shellState)));
    expect(result.current[0]).not.toBeNull();

    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
  });
});
