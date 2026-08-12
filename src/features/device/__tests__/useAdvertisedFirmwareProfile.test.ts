import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FIRMWARE_PROFILE } from "@/shared/contracts/device";
import { createFirmwareProfileEventBus } from "../firmwareProfileEvents";
import { useAdvertisedFirmwareProfile } from "../useAdvertisedFirmwareProfile";

describe("useAdvertisedFirmwareProfile", () => {
  it("starts undefined and updates when the bus emits", () => {
    const bus = createFirmwareProfileEventBus();
    const { result } = renderHook(() => useAdvertisedFirmwareProfile({ firmwareProfileEvents: bus }));

    expect(result.current).toBeUndefined();

    act(() => {
      bus.emit({ advertisedFirmwareProfile: FIRMWARE_PROFILE.ADALIGHT });
    });

    expect(result.current).toBe(FIRMWARE_PROFILE.ADALIGHT);
  });

  it("mirrors a later undefined emit (handshake no longer definite)", () => {
    const bus = createFirmwareProfileEventBus();
    const { result } = renderHook(() => useAdvertisedFirmwareProfile({ firmwareProfileEvents: bus }));

    act(() => {
      bus.emit({ advertisedFirmwareProfile: FIRMWARE_PROFILE.LUMASYNC_V1 });
    });
    expect(result.current).toBe(FIRMWARE_PROFILE.LUMASYNC_V1);

    act(() => {
      bus.emit({ advertisedFirmwareProfile: undefined });
    });
    expect(result.current).toBeUndefined();
  });

  it("unsubscribes on unmount", () => {
    const bus = createFirmwareProfileEventBus();
    const { unmount } = renderHook(() => useAdvertisedFirmwareProfile({ firmwareProfileEvents: bus }));

    unmount();

    // No listener should remain — emitting after unmount must not throw
    // and must not resurrect any stale subscriber.
    expect(() => bus.emit({ advertisedFirmwareProfile: FIRMWARE_PROFILE.ADALIGHT })).not.toThrow();
  });
});
