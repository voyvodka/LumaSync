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

vi.mock("@/features/shell/launchApi", () => ({
  readE2eBuild: vi.fn().mockResolvedValue(false),
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------
import { listen } from "@tauri-apps/api/event";
import { shellStore } from "@/features/persistence/shellStore";
import { readE2eBuild } from "@/features/shell/launchApi";
import { checkForUpdate, downloadAndInstallUpdate } from "../updaterApi";
import { useAutoUpdater } from "../useAutoUpdater";
import { isUpdateModalStatus } from "../updateModalStatus";
import { UPDATE_CHECK_FAILED_NOTICE_MS } from "../useUpdateCheckFailedNotice";

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
    vi.mocked(readE2eBuild).mockResolvedValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
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
      // Uncoded, yet still a check failure: the wording must not say install.
      expect(result.current.state.phase).toBe("check");
      expect(result.current.state.code).toBeUndefined();
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
      expect(result.current.state.phase).toBe("install");
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

  it("shows installing once the install succeeds, even without the finished event", async () => {
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
      getHandler()?.({ payload: { downloadedBytes: 900, totalBytes: 1000, finished: false } });
    });
    expect(result.current.state.status).toBe("downloading");

    await act(async () => {
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

  /** The startup check nobody asked for. It fails on every offline boot, so a
   *  failure is a notice, never the modal. */
  describe("background check", () => {
    const modalShown = (current: ReturnType<typeof useAutoUpdater>) =>
      current.isModalOpen && isUpdateModalStatus(current.state);

    async function runBackground() {
      const hook = renderHook(() => useAutoUpdater());
      await act(async () => {
        await hook.result.current.checkForUpdatesInBackground();
      });
      return hook;
    }

    it("does not open the modal when the invoke layer rejects, and raises the notice", async () => {
      vi.mocked(checkForUpdate).mockRejectedValue(new Error("check_for_update not allowed"));

      const { result } = await runBackground();

      expect(modalShown(result.current)).toBe(false);
      expect(result.current.state.status).toBe("idle");
      expect(result.current.checkFailedNotice).toEqual({ message: "check_for_update not allowed" });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("[LumaSync] update check rejected (background)"),
        expect.any(Error),
      );
    });

    it("does not open the modal on a coded check failure, and logs it", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        status: status(UPDATER_STATUS.CHECK_FAILED, "offline"),
        channel: "stable",
        update: null,
      });

      const { result } = await runBackground();

      expect(modalShown(result.current)).toBe(false);
      expect(result.current.checkFailedNotice).toEqual({ code: UPDATER_STATUS.CHECK_FAILED, message: "offline" });
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("[LumaSync] update check failed (background)"),
        { code: UPDATER_STATUS.CHECK_FAILED, message: "offline" },
      );
    });

    it("still opens the modal when an update is available", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        status: status(UPDATER_STATUS.UPDATE_AVAILABLE),
        channel: "stable",
        update: UPDATE,
      });

      const { result } = await runBackground();

      expect(result.current.state.status).toBe("available");
      expect(modalShown(result.current)).toBe(true);
      expect(result.current.checkFailedNotice).toBeNull();
    });

    it("never reaches the feed in the e2e build", async () => {
      vi.mocked(readE2eBuild).mockResolvedValue(true);

      const { result } = await runBackground();

      expect(checkForUpdate).not.toHaveBeenCalled();
      expect(result.current.state.status).toBe("idle");
      expect(result.current.checkFailedNotice).toBeNull();
    });

    it("a user check still opens the modal on the same failure", async () => {
      vi.mocked(checkForUpdate).mockRejectedValue(new Error("check_for_update not allowed"));
      const { result } = await runBackground();
      expect(result.current.checkFailedNotice).not.toBeNull();

      await act(async () => {
        await result.current.checkForUpdates();
      });

      expect(modalShown(result.current)).toBe(true);
      expect(result.current.state).toMatchObject({ status: "error", phase: "check" });
      // The modal now says it; the notice would only repeat it.
      expect(result.current.checkFailedNotice).toBeNull();
    });

    it("keeps the notice through a retry and clears it once the retry succeeds", async () => {
      vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("offline"));
      const { result } = await runBackground();
      const failure = result.current.checkFailedNotice;
      expect(failure).not.toBeNull();

      let resolveCheck: ((value: Awaited<ReturnType<typeof checkForUpdate>>) => void) | undefined;
      vi.mocked(checkForUpdate).mockImplementationOnce(
        () => new Promise((resolve) => (resolveCheck = resolve)),
      );
      let pending: Promise<void>;
      await act(async () => {
        pending = result.current.checkForUpdates();
        await Promise.resolve();
      });
      expect(result.current.state.status).toBe("checking");
      expect(result.current.checkFailedNotice).toBe(failure);

      await act(async () => {
        resolveCheck?.({ status: status(UPDATER_STATUS.UP_TO_DATE), channel: "stable", update: null });
        await pending;
      });
      expect(result.current.checkFailedNotice).toBeNull();
      expect(modalShown(result.current)).toBe(false);
    });

    it("does not let the notice expire under a retry that is still running", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("offline"));
        const { result } = await runBackground();
        expect(result.current.checkFailedNotice).not.toBeNull();

        // A slow feed: the retry outlives the notice's own countdown.
        vi.mocked(checkForUpdate).mockReturnValueOnce(new Promise(() => {}));
        await act(async () => {
          void result.current.checkForUpdates();
          await Promise.resolve();
        });
        await act(async () => {
          vi.advanceTimersByTime(UPDATE_CHECK_FAILED_NOTICE_MS * 2);
        });

        expect(result.current.state.status).toBe("checking");
        expect(result.current.checkFailedNotice).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets the notice go on its own timer, counted only while the window is visible", async () => {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      try {
        vi.mocked(checkForUpdate).mockRejectedValue(new Error("offline"));
        const { result } = await runBackground();

        // Started in the tray: nobody has seen it yet.
        await act(async () => {
          vi.advanceTimersByTime(UPDATE_CHECK_FAILED_NOTICE_MS * 2);
        });
        expect(result.current.checkFailedNotice).not.toBeNull();

        visibility.mockReturnValue("visible");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
          vi.advanceTimersByTime(UPDATE_CHECK_FAILED_NOTICE_MS - 1);
        });
        expect(result.current.checkFailedNotice).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(1);
        });
        expect(result.current.checkFailedNotice).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
