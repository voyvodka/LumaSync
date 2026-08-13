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
  const updateConfig = vi.fn().mockResolvedValue(undefined);
  const setSelectedId = vi.fn();
  const hook = renderHook(() =>
    useRoomMapImageLayers({
      config: { ...DEFAULT_ROOM_MAP, imageLayers: [] },
      updateConfig,
      setSelectedId,
    }),
  );
  return { ...hook, updateConfig, setSelectedId };
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

    const { result, updateConfig, setSelectedId } = renderImageLayers();

    await act(async () => {
      await result.current.handleAddImage();
    });

    await waitFor(() => expect(result.current.imageError).toBe("copy failed"));
    expect(updateConfig).not.toHaveBeenCalled();
    expect(setSelectedId).not.toHaveBeenCalled();
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

    const { result, updateConfig, setSelectedId } = renderImageLayers();

    await act(async () => {
      await result.current.handleAddImage();
    });
    await waitFor(() => expect(result.current.imageError).toBe("dialog unavailable"));

    await act(async () => {
      await result.current.handleAddImage();
    });

    await waitFor(() => expect(result.current.imageError).toBeNull());
    consoleError.mockRestore();
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        imageLayers: [expect.objectContaining({ path: "/data/plan.png", label: "plan" })],
      }),
    );
    expect(setSelectedId).toHaveBeenCalled();
  });
});
