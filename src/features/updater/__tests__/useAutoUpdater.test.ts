/** useAutoUpdater state machine, mocked at `../updaterApi`, `listen` and the
 * shell store. The commands never reject — a rejection is the invoke layer
 * failing, which is a separate path from a coded failure, and both are covered. */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { UPDATER_STATUS, type UpdateDownloadProgress, type UpdateMetadata } from "@/shared/contracts/updater";

// ---------------------------------------------------------------------------
// Module mocks — vi.mock paths are resolved relative to the TEST file location
// ---------------------------------------------------------------------------

vi.mock("../updaterApi", () => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({ updateChannel: "stable" }),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------
import { listen } from "@tauri-apps/api/event";
import { shellStore } from "@/features/persistence/shellStore";
import { checkForUpdate, downloadAndInstallUpdate } from "../updaterApi";
import { useAutoUpdater } from "../useAutoUpdater";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UPDATE: UpdateMetadata = {
  version: "1.2.3",
  currentVersion: "1.0.0",
  date: "2026-05-04",
  body: "test release",
};

function status(code: string, message = "") {
  return { code, message, details: null } as never;
}

/** Capture the progress handler so a test can drive it like Rust would. */
function captureProgressHandler() {
  let handler: ((event: { payload: UpdateDownloadProgress }) => void) | undefined;
  vi.mocked(listen).mockImplementation(((_event: string, cb: never) => {
    handler = cb as unknown as typeof handler;
    return Promise.resolve(() => {});
  }) as never);
  return () => handler;
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
    vi.mocked(listen).mockResolvedValue((() => {}) as never);
    vi.mocked(downloadAndInstallUpdate).mockResolvedValue({
      status: status(UPDATER_STATUS.INSTALL_STARTED),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transitions idle → available when an update exists", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      status: status(UPDATER_STATUS.UPDATE_AVAILABLE),
      channel: "stable",
      update: UPDATE,
    });

    const { result } = renderHook(() => useAutoUpdater());
    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("available");
    if (result.current.state.status === "available") {
      expect(result.current.state.update).toEqual(UPDATE);
    }
  });

  it("transitions to error state when the invoke layer rejects", async () => {
    vi.mocked(checkForUpdate).mockRejectedValue(new Error("network timeout"));

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("network timeout");
    }
  });

  /** A coded failure is not a rejection — it must still surface as an error. */
  it("surfaces UPDATER_CHECK_FAILED as an error without a rejection", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      status: status(UPDATER_STATUS.CHECK_FAILED, "Could not reach the update feed."),
      channel: "stable",
      update: null,
    });

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("Could not reach the update feed.");
    }
  });

  it("stays idle when the feed reports UPDATER_UP_TO_DATE", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      status: status(UPDATER_STATUS.UP_TO_DATE),
      channel: "stable",
      update: null,
    });

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("idle");
  });

  it("transitions to error when the install command rejects", async () => {
    vi.mocked(downloadAndInstallUpdate).mockRejectedValue(new Error("disk full"));

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.downloadAndInstall(UPDATE);
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("disk full");
    }
  });

  it("transitions to error when the install returns UPDATER_INSTALL_FAILED", async () => {
    vi.mocked(downloadAndInstallUpdate).mockResolvedValue({
      status: status(UPDATER_STATUS.INSTALL_FAILED, "signature mismatch"),
    });

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.downloadAndInstall(UPDATE);
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("signature mismatch");
    }
  });

  it("reports download progress from the Rust event, then switches to installing", async () => {
    const getHandler = captureProgressHandler();
    let resolveInstall: (() => void) | undefined;
    vi.mocked(downloadAndInstallUpdate).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = () => resolve({ status: status(UPDATER_STATUS.INSTALL_STARTED) });
        }),
    );

    const { result } = renderHook(() => useAutoUpdater());

    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.downloadAndInstall(UPDATE);
      await Promise.resolve();
    });

    await act(async () => {
      getHandler()?.({ payload: { downloadedBytes: 500, totalBytes: 1000, finished: false } });
    });

    expect(result.current.state.status).toBe("downloading");
    if (result.current.state.status === "downloading") {
      expect(result.current.state.progress).toBe(50);
      expect(result.current.state.totalBytes).toBe(1000);
    }

    await act(async () => {
      getHandler()?.({ payload: { downloadedBytes: 1000, totalBytes: 1000, finished: true } });
      resolveInstall?.();
      await pending;
    });

    expect(result.current.state.status).toBe("installing");
  });

  it("channel reflects what Rust says it used, not just the store", async () => {
    vi.mocked(shellStore.load).mockResolvedValue(
      { updateChannel: "beta" } as Awaited<ReturnType<typeof shellStore.load>>,
    );
    vi.mocked(checkForUpdate).mockResolvedValue({
      status: status(UPDATER_STATUS.UP_TO_DATE),
      channel: "beta",
      update: null,
    });

    const { result } = renderHook(() => useAutoUpdater());
    expect(result.current.channel).toBe("stable");

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.channel).toBe("beta");
  });

  it("dismiss() closes the modal without discarding what the updater is doing", async () => {
    vi.mocked(checkForUpdate).mockRejectedValue(new Error("oops"));

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });
    expect(result.current.state.status).toBe("error");
    expect(result.current.isModalOpen).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isModalOpen).toBe(false);
    // The state itself is untouched — collapsing it to `idle` is what let a
    // later progress event resurrect the modal from scratch.
    expect(result.current.state.status).toBe("error");
  });

  it("stringifies non-Error rejection values into the error message", async () => {
    vi.mocked(checkForUpdate).mockRejectedValue("string rejection");

    const { result } = renderHook(() => useAutoUpdater());

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toBe("string rejection");
    }
  });
  describe("dismissal survives the events that used to reopen the modal", () => {
    async function startDownload() {
      const getHandler = captureProgressHandler();
      vi.mocked(downloadAndInstallUpdate).mockReturnValue(new Promise(() => {}) as never);
      const { result } = renderHook(() => useAutoUpdater());
      await act(async () => {
        void result.current.downloadAndInstall(UPDATE);
      });
      return { result, getHandler };
    }

    it("keeps the modal shut while the download it dismissed keeps reporting", async () => {
      const { result, getHandler } = await startDownload();
      expect(result.current.state.status).toBe("downloading");

      act(() => {
        result.current.dismiss();
      });
      expect(result.current.isModalOpen).toBe(false);

      // The exact event that used to reopen it — the download is still running,
      // which is what "continue in background" asked for.
      act(() => {
        getHandler()?.({ payload: { downloadedBytes: 512, totalBytes: 2048, finished: false } });
      });

      expect(result.current.isModalOpen).toBe(false);
      expect(result.current.state.status).toBe("downloading");
      if (result.current.state.status === "downloading") {
        expect(result.current.state.downloadedBytes).toBe(512);
      }
    });

    it("re-opens when the download finishes, because a relaunch is not what was declined", async () => {
      const { result, getHandler } = await startDownload();
      act(() => {
        result.current.dismiss();
      });

      act(() => {
        getHandler()?.({ payload: { downloadedBytes: 2048, totalBytes: 2048, finished: true } });
      });

      expect(result.current.state.status).toBe("installing");
      expect(result.current.isModalOpen).toBe(true);
    });

    it("re-opens for a newer version after the previous one was put off", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        status: status(UPDATER_STATUS.UPDATE_AVAILABLE),
        channel: "stable",
        update: UPDATE,
      });
      const { result } = renderHook(() => useAutoUpdater());

      await act(async () => {
        await result.current.checkForUpdates();
      });
      act(() => {
        result.current.dismiss();
      });
      expect(result.current.isModalOpen).toBe(false);

      // Same status, different answer: suppressing it would hide the new
      // version behind the previous "Later".
      await act(async () => {
        await result.current.checkForUpdates();
      });

      expect(result.current.isModalOpen).toBe(true);
    });
  });
});
