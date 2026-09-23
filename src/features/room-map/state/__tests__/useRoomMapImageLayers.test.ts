import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { useRoomMapImageLayers } from "../useRoomMapImageLayers";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockOpen = vi.fn();
const mockCopyBackgroundImage = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (options: unknown) => mockOpen(options),
}));

vi.mock("../../roomMapApi", () => ({
  copyBackgroundImage: (source: string) => mockCopyBackgroundImage(source),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderImageLayers() {
  const apply = vi.fn();
  const select = vi.fn();
  const hook = renderHook(() =>
    useRoomMapImageLayers({
      config: { ...DEFAULT_ROOM_MAP, imageLayers: [] },
      apply,
      select,
    }),
  );
  return { ...hook, apply, select };
}

// ---------------------------------------------------------------------------
// handleAddImage — failure reporting
// ---------------------------------------------------------------------------

describe("useRoomMapImageLayers.handleAddImage", () => {
  beforeEach(() => {
    mockOpen.mockReset();
    mockCopyBackgroundImage.mockReset();
  });

  it("reports a rejected file dialog instead of swallowing it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockOpen.mockRejectedValue(new Error("dialog unavailable"));

    const { result } = renderImageLayers();

    await act(async () => {
      await result.current.handleAddImage();
    });

    await waitFor(() => expect(result.current.imageError).toBe("dialog unavailable"));
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] Room map image import failed: dialog unavailable"),
    );
    consoleError.mockRestore();
  });

  it("reports a failed image copy instead of silently doing nothing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockOpen.mockResolvedValue("/tmp/plan.png");
    mockCopyBackgroundImage.mockRejectedValue(new Error("copy failed"));

    const { result, apply, select } = renderImageLayers();

    await act(async () => {
      await result.current.handleAddImage();
    });

    await waitFor(() => expect(result.current.imageError).toBe("copy failed"));
    expect(apply).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] Room map image import failed: copy failed"),
    );
    consoleError.mockRestore();
  });

  it("clears a previous failure and adds the layer on a successful import", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockOpen.mockRejectedValueOnce(new Error("dialog unavailable"));
    mockOpen.mockResolvedValue("/tmp/plan.png");
    mockCopyBackgroundImage.mockResolvedValue("/data/plan.png");

    const { result, apply, select } = renderImageLayers();

    await act(async () => {
      await result.current.handleAddImage();
    });
    await waitFor(() => expect(result.current.imageError).toBe("dialog unavailable"));

    await act(async () => {
      await result.current.handleAddImage();
    });

    await waitFor(() => expect(result.current.imageError).toBeNull());
    consoleError.mockRestore();
    expect(apply).toHaveBeenCalledTimes(1);
    // An updater: the dialog stayed open for as long as the user liked, so the
    // layer lands on the map as it is when it closes.
    const patch = apply.mock.calls[0][0];
    expect(patch({ ...DEFAULT_ROOM_MAP, imageLayers: [] })).toEqual({
      imageLayers: [expect.objectContaining({ path: "/data/plan.png", label: "plan" })],
    });
    expect(select).toHaveBeenCalled();
  });
});
