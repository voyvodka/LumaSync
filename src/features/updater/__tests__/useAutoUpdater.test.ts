/**
 * useAutoUpdater — state machine coverage (F7-a)
 *
 * Covers all 6 UpdaterState variants:
 *   idle | checking | available | downloading | installing | error
 *
 * Mock boundaries:
 *   - @tauri-apps/plugin-updater — mocked at module level; `check` is a vi.fn()
 *   - ../../persistence/shellStore — load() resolves to a controlled ShellState
 *
 * NOTE (GAP 11): Rust-side tests are not yet gated in CI (Platform GAP 11 / v1.4 P0).
 * These are frontend-only Vitest tests and run in CI today.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";

// ---------------------------------------------------------------------------
// Module mocks — vi.mock paths are resolved relative to the TEST file location
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

// useAutoUpdater.ts imports shellStore as "../persistence/shellStore"
// (relative to src/features/updater/). From the test in __tests__/ the
// equivalent path is "../../persistence/shellStore". Vitest resolves vi.mock
// paths relative to the test file, so we must use the test-relative path.
vi.mock("../../persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({ updateChannel: "stable" }),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------
import { check } from "@tauri-apps/plugin-updater";
import { shellStore } from "../../persistence/shellStore";
import { useAutoUpdater } from "../useAutoUpdater";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Update stub that satisfies the plugin type surface we actually use */
function makeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    version: "1.2.3",
    currentVersion: "1.0.0",
    date: "2026-05-04",
    body: "test release",
    available: true,
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Update;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAutoUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shellStore.load).mockResolvedValue(
      { updateChannel: "stable" } as Awaited<ReturnType<typeof shellStore.load>>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: happy path idle → checking → available
  // -------------------------------------------------------------------------
  it("transitions idle → available when an update exists", async () => {
    const update = makeUpdate();
    vi.mocked(check).mockResolvedValue(update);

    const { result } = renderHook(() => useAutoUpdater());

    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("available");
    if (result.current.state.status === "available") {
      expect(result.current.state.update).toBe(update);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: check() rejects → error with message preserved
  // -------------------------------------------------------------------------
  it("transitions to error state when check() rejects", async () => {
    vi.mocked(check).mockRejectedValue(new Error("network timeout"));

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("network timeout");
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 3: check() resolves null → state stays at idle
  // -------------------------------------------------------------------------
  it("stays idle when check() resolves with null (no update available)", async () => {
    vi.mocked(check).mockResolvedValue(null);

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("idle");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: downloadAndInstall() rejects → error state
  // -------------------------------------------------------------------------
  it("transitions to error when downloadAndInstall() rejects", async () => {
    const update = makeUpdate({
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.downloadAndInstall(update);
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("disk full");
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 5: downloadAndInstall fires Finished → installing state
  // -------------------------------------------------------------------------
  it("transitions to installing after Finished progress event", async () => {
    const update = makeUpdate({
      downloadAndInstall: vi.fn().mockImplementation(
        async (onEvent: (e: { event: string; data: Record<string, number> }) => void) => {
          onEvent({ event: "Started", data: { contentLength: 1000 } });
          onEvent({ event: "Progress", data: { chunkLength: 500 } });
          onEvent({ event: "Finished", data: {} });
        },
      ),
    });

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.downloadAndInstall(update);
    });

    // After Finished event the state must be "installing"
    expect(result.current.state.status).toBe("installing");
  });

  // -------------------------------------------------------------------------
  // Scenario 6: channel reflects persisted updateChannel
  // -------------------------------------------------------------------------
  it("channel reflects the persisted updateChannel (beta)", async () => {
    vi.mocked(shellStore.load).mockResolvedValue(
      { updateChannel: "beta" } as Awaited<ReturnType<typeof shellStore.load>>,
    );
    vi.mocked(check).mockResolvedValue(null);

    const { result } = renderHook(() => useAutoUpdater());

    // Channel is initialised to DEFAULT_UPDATE_CHANNEL ("stable") before first check
    expect(result.current.channel).toBe("stable");

    await act(async () => {
      await result.current.checkForUpdates();
    });

    // After checkForUpdates reads shellStore the channel must update to "beta"
    expect(result.current.channel).toBe("beta");
  });

  // -------------------------------------------------------------------------
  // Scenario 7: dismiss() resets any non-idle state back to idle
  // -------------------------------------------------------------------------
  it("dismiss() resets state back to idle", async () => {
    vi.mocked(check).mockRejectedValue(new Error("oops"));

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("error");

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.state.status).toBe("idle");
  });

  // -------------------------------------------------------------------------
  // Scenario 8: non-Error rejection message is stringified
  // -------------------------------------------------------------------------
  it("stringifies non-Error rejection values into the error message", async () => {
    vi.mocked(check).mockRejectedValue("string rejection");

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("string rejection");
    }
  });
});
