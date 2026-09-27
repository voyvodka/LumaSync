import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { __resetSessionStateForTests, useSessionState } from "../useSessionState";

describe("useSessionState", () => {
  it("picks up where it left off on a remount", () => {
    const first = renderHook(() => useSessionState("page", "general"));
    act(() => first.result.current[1]("about"));
    first.unmount();

    const again = renderHook(() => useSessionState("page", "general"));
    expect(again.result.current[0]).toBe("about");
  });

  it("starts from its initial value in a fresh session", () => {
    const first = renderHook(() => useSessionState("page", "general"));
    act(() => first.result.current[1]("about"));
    first.unmount();
    __resetSessionStateForTests();

    expect(renderHook(() => useSessionState("page", "general")).result.current[0]).toBe("general");
  });

  it("keeps each key apart", () => {
    const settings = renderHook(() => useSessionState("settings.page", "general"));
    act(() => settings.result.current[1]("help"));

    expect(renderHook(() => useSessionState("devices.category", "usb")).result.current[0]).toBe("usb");
  });
});
