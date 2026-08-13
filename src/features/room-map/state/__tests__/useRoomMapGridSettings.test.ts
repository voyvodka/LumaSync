// Guards the `gridSettingsLoaded` once-flag: without it the persist effect's
// mount pass writes hook defaults over the user's stored grid settings.
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { load, save } = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: (...args: unknown[]) => load(...args),
    save: (...args: unknown[]) => save(...args),
  },
}));

import { useRoomMapGridSettings } from "../useRoomMapGridSettings";

describe("useRoomMapGridSettings", () => {
  beforeEach(() => {
    load.mockReset();
    save.mockReset();
    save.mockResolvedValue(undefined);
  });

  it("writes nothing while the stored settings are still loading", async () => {
    load.mockReturnValue(new Promise(() => {}));

    renderHook(() => useRoomMapGridSettings());

    // The persist effect runs on mount. Writing here would clobber the stored
    // settings with the hook defaults before they have even been read.
    expect(save).not.toHaveBeenCalled();
  });

  it("never persists the defaults over the stored values", async () => {
    load.mockResolvedValue({
      roomMapShowGrid: false,
      roomMapGridStrokeWidth: 1.5,
      roomMapShowHueZones: false,
    });

    const { result } = renderHook(() => useRoomMapGridSettings());

    await waitFor(() => expect(result.current.showGrid).toBe(false));

    for (const call of save.mock.calls) {
      expect(call[0]).not.toMatchObject({
        roomMapShowGrid: true,
        roomMapGridStrokeWidth: 0.5,
        roomMapShowHueZones: true,
      });
    }
    expect(result.current.gridStrokeWidth).toBe(1.5);
    expect(result.current.showHueZones).toBe(false);
  });
});
