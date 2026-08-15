import { useState, useCallback, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { shellStore } from "../persistence/shellStore";
import { DEFAULT_UPDATE_CHANNEL, type UpdateChannel } from "@/shared/contracts/shell";
import {
  UPDATER_PROGRESS_EVENT,
  UPDATER_STATUS,
  type UpdaterStatusCode,
  type UpdateDownloadProgress,
  type UpdateMetadata,
} from "@/shared/contracts/updater";
import { checkForUpdate, downloadAndInstallUpdate } from "./updaterApi";
import { createLatestOperationGuard } from "@/shared/lib/latestOperation";

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; update: UpdateMetadata }
  | {
      status: "downloading";
      update: UpdateMetadata;
      progress: number;
      downloadedBytes: number;
      totalBytes: number;
      bytesPerSecond: number;
      etaSeconds: number | null;
    }
  | { status: "installing"; update: UpdateMetadata }
  /** `code` decides the wording; `message` is the raw backend detail, which for
   *  a failed check embeds the feed URL and must not be the headline. */
  | { status: "error"; code?: UpdaterStatusCode; message: string };

/** Rendered as a badge, so it is refreshed from the store before every check.
 * Rust reads the same field to pick the endpoint and echoes it back — a
 * disagreement between the two reads is a bug this surfaces rather than hides. */
async function readUpdateChannel(): Promise<UpdateChannel> {
  try {
    const state = await shellStore.load();
    return state.updateChannel ?? DEFAULT_UPDATE_CHANNEL;
  } catch {
    return DEFAULT_UPDATE_CHANNEL;
  }
}

export function useAutoUpdater() {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  const [channel, setChannel] = useState<UpdateChannel>(DEFAULT_UPDATE_CHANNEL);
  // Hides the status that was dismissed, not the updater. Setting `idle`
  // instead hid nothing — the progress listener kept writing `downloading`.
  const [dismissedStatus, setDismissedStatus] = useState<UpdaterState["status"] | null>(null);
  const lastStartRef = useRef<number>(0);
  const checkGuardRef = useRef(createLatestOperationGuard());

  const checkForUpdates = useCallback(async () => {
    // A newer version is new information even though the status is `available`
    // again, so it must not stay hidden behind the previous "Later".
    setDismissedStatus(null);
    // The startup check and a Retry press can be in flight together and resolve
    // in either order; without this the older answer lands last and wins.
    const isLatest = checkGuardRef.current.begin();

    const storedChannel = await readUpdateChannel();
    if (!isLatest()) return;
    setChannel(storedChannel);
    setState({ status: "checking" });

    try {
      const response = await checkForUpdate();
      if (!isLatest()) return;
      // Rust's answer wins over the store read above: it is what actually
      // chose the endpoint the result came from.
      setChannel(response.channel);

      if (response.status.code === UPDATER_STATUS.UPDATE_AVAILABLE && response.update) {
        setState({ status: "available", update: response.update });
      } else if (response.status.code === UPDATER_STATUS.UP_TO_DATE) {
        setState({ status: "idle" });
      } else {
        setState({
          status: "error",
          code: response.status.code,
          message: response.status.message,
        });
      }
    } catch (err) {
      if (!isLatest()) return;
      // The command never rejects; this is the invoke layer itself failing —
      // an unregistered command, or a window torn down mid-check.
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", message });
    }
  }, []);

  const downloadAndInstall = useCallback(async (update: UpdateMetadata) => {
    let unlisten: UnlistenFn | undefined;
    setDismissedStatus(null);
    try {
      let total = 0;
      lastStartRef.current = Date.now();

      setState({
        status: "downloading",
        update,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        etaSeconds: null,
      });

      unlisten = await listen<UpdateDownloadProgress>(UPDATER_PROGRESS_EVENT, (event) => {
        const { downloadedBytes, totalBytes, finished } = event.payload;
        if (finished) {
          setState({ status: "installing", update });
          return;
        }
        if (totalBytes) total = totalBytes;
        const elapsedMs = Math.max(1, Date.now() - lastStartRef.current);
        const bytesPerSecond = Math.round((downloadedBytes / elapsedMs) * 1000);
        const remaining = total > 0 ? Math.max(0, total - downloadedBytes) : 0;
        const etaSeconds =
          total > 0 && bytesPerSecond > 0 ? Math.max(0, Math.round(remaining / bytesPerSecond)) : null;
        setState({
          status: "downloading",
          update,
          progress: total > 0 ? Math.round((downloadedBytes / total) * 100) : 0,
          downloadedBytes,
          totalBytes: total,
          bytesPerSecond,
          etaSeconds,
        });
      });

      const response = await downloadAndInstallUpdate();
      if (response.status.code !== UPDATER_STATUS.INSTALL_STARTED) {
        setState({
          status: "error",
          code: response.status.code,
          message: response.status.message,
        });
      }
      // On success the app is replaced and relaunched, so no state change here.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", message });
    } finally {
      unlisten?.();
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissedStatus(state.status);
  }, [state.status]);

  // Dev-only escape hatch for testing the 4 modal states without a real updater endpoint.
  // Kept permanently in DEV so the panel remains usable across sessions.
  const devSetState = useCallback((next: UpdaterState) => {
    if (!import.meta.env.DEV) return;
    setDismissedStatus(null);
    setState(next);
  }, []);

  // A dismissed `downloading` still reaches `installing`, and that transition
  // re-opens on purpose: the app is about to be replaced and relaunched, which
  // is not the interruption the user declined.
  const isModalOpen = state.status !== dismissedStatus;

  return { state, channel, isModalOpen, checkForUpdates, downloadAndInstall, dismiss, devSetState };
}
