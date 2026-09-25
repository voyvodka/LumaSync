import { useState, useCallback, useRef } from "react";

import { shellStore } from "../persistence/shellStore";
import { APP_VERSION } from "@/shared/constants/app";
import { defaultUpdateChannel, resolveUpdateChannel, type UpdateChannel } from "@/shared/contracts/shell";
import {
  UPDATER_STATUS,
  type UpdaterStatusCode,
  type UpdateMetadata,
} from "@/shared/contracts/updater";
import { checkForUpdate, downloadAndInstallUpdate } from "./updaterApi";
import { listenUpdateDownloadProgress, type UnlistenFn } from "./updaterEventsApi";
import { useUpdateCheckFailedNotice, type UpdateCheckFailure } from "./useUpdateCheckFailedNotice";
import { readE2eBuild } from "@/features/shell/launchApi";
import { createLatestOperationGuard } from "@/shared/lib/latestOperation";
import { parseCommandError } from "@/shared/contracts/status";

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
  /** `phase` decides the wording: a check that failed for any reason, coded or
   *  not, is not a failed installation. `message` is the raw backend detail,
   *  which for a failed check embeds the feed URL and must not be the headline. */
  | { status: "error"; phase: UpdaterErrorPhase; code?: UpdaterStatusCode; message: string };

export type UpdaterErrorPhase = "check" | "install";

/** `background` is a check nobody asked for; it never opens the modal on failure. */
type UpdateCheckTrigger = "user" | "background";

/**
 * What a background check came to, for the schedule that runs it: `failed`
 * retries sooner, `done` waits a full interval, and `off` stops the schedule.
 */
export type BackgroundCheckOutcome = "done" | "failed" | "off";

/** Rendered as a badge, so it is refreshed from the store before every check.
 * Rust reads the same field to pick the endpoint and echoes it back — a
 * disagreement between the two reads is a bug this surfaces rather than hides. */
async function readUpdateChannel(): Promise<UpdateChannel> {
  try {
    const state = await shellStore.load();
    return resolveUpdateChannel(state.updateChannel, APP_VERSION);
  } catch (err) {
    console.error("[LumaSync] update channel read failed; using default:", err);
    return defaultUpdateChannel(APP_VERSION);
  }
}

export function useAutoUpdater() {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [channel, setChannel] = useState<UpdateChannel>(() => defaultUpdateChannel(APP_VERSION));
  // Hides the status that was dismissed, not the updater. Setting `idle`
  // instead hid nothing — the progress listener kept writing `downloading`.
  const [dismissedStatus, setDismissedStatus] = useState<UpdaterState["status"] | null>(null);
  const dismissedStatusRef = useRef(dismissedStatus);
  dismissedStatusRef.current = dismissedStatus;
  // An up-to-date answer leaves the state at `idle`, which is also "never
  // checked"; without this a check the user asked for said nothing at all.
  const [upToDateAt, setUpToDateAt] = useState<number | null>(null);
  const lastStartRef = useRef<number>(0);
  const checkGuardRef = useRef(createLatestOperationGuard());

  const {
    notice: checkFailedNotice,
    report: reportCheckFailed,
    hold: holdCheckFailed,
    clear: clearCheckFailed,
  } = useUpdateCheckFailedNotice();

  // A check that lost to a later one reports `done`: the later one answers for both.
  const runCheck = useCallback(
    async (trigger: UpdateCheckTrigger): Promise<"done" | "failed"> => {
      // A newer version is new information even though the status is `available`
      // again, so it must not stay hidden behind the previous "Later".
      setDismissedStatus(null);
      // The startup check and a Retry press can be in flight together and resolve
      // in either order; without this the older answer lands last and wins.
      const isLatest = checkGuardRef.current.begin();
      if (trigger === "user") {
        holdCheckFailed();
        setUpToDateAt(null);
      }

      const storedChannel = await readUpdateChannel();
      if (!isLatest()) return "done";
      setChannel(storedChannel);
      setState({ status: "checking" });

      // A background failure is logged and offered as a notice; only a check the
      // user asked for may put the modal over the window.
      const fail = (failure: UpdateCheckFailure): "failed" => {
        if (trigger === "background") {
          setState({ status: "idle" });
          reportCheckFailed(failure);
        } else {
          clearCheckFailed();
          setState({ status: "error", phase: "check", ...failure });
        }
        return "failed";
      };

      try {
        const response = await checkForUpdate();
        if (!isLatest()) return "done";
        // Rust's answer wins over the store read above: it is what actually
        // chose the endpoint the result came from.
        setChannel(response.channel);

        if (response.status.code === UPDATER_STATUS.UPDATE_AVAILABLE && response.update) {
          clearCheckFailed();
          setState({ status: "available", update: response.update });
        } else if (response.status.code === UPDATER_STATUS.UP_TO_DATE) {
          clearCheckFailed();
          setState({ status: "idle" });
          if (trigger === "user") setUpToDateAt(Date.now());
        } else {
          console.warn(`[LumaSync] update check failed (${trigger}):`, {
            code: response.status.code,
            message: response.status.message,
          });
          return fail({ code: response.status.code, message: response.status.message });
        }
        return "done";
      } catch (err) {
        if (!isLatest()) return "done";
        // The command never rejects; this is the invoke layer itself failing —
        // an unregistered command, or a window torn down mid-check.
        console.error(`[LumaSync] update check rejected (${trigger}):`, err);
        return fail({ message: parseCommandError(err).message });
      }
    },
    [holdCheckFailed, reportCheckFailed, clearCheckFailed],
  );

  /** A check the user asked for: Retry, the Software update button, the notice. */
  const checkForUpdates = useCallback(async () => {
    await runCheck("user");
  }, [runCheck]);

  const checkForUpdatesInBackground = useCallback(async (): Promise<BackgroundCheckOutcome> => {
    // The e2e binary drives the real window; whatever the live feed answers
    // would land over the screens a spec is asserting on.
    if (await readE2eBuild()) {
      console.info("[LumaSync] e2e build: background update checks skipped");
      return "off";
    }
    // Never on top of a check in flight, an update already found, or one being
    // installed: a re-check would reopen a prompt the user put off with "Later",
    // or reset a download under way. The next scheduled check tries again.
    const busy = stateRef.current.status;
    if (busy === "checking" || busy === "available" || busy === "downloading" || busy === "installing") {
      return "done";
    }
    // An error the prompt still shows is the user's to answer.
    if (busy === "error" && dismissedStatusRef.current !== "error") return "done";
    return runCheck("background");
  }, [runCheck]);

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

      unlisten = await listenUpdateDownloadProgress((progress) => {
        const { downloadedBytes, totalBytes, finished } = progress;
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
      if (response.status.code === UPDATER_STATUS.INSTALL_STARTED) {
        // The backend is already restarting the app. Said here as well as by
        // the `finished` event, so a missed event cannot leave the modal on a
        // download bar until the window goes away.
        setState({ status: "installing", update });
      } else {
        setState({
          status: "error",
          phase: "install",
          code: response.status.code,
          message: response.status.message,
        });
      }
    } catch (err) {
      const message = parseCommandError(err).message;
      setState({ status: "error", phase: "install", message });
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

  return {
    state,
    channel,
    isModalOpen,
    checkForUpdates,
    checkForUpdatesInBackground,
    checkFailedNotice,
    upToDateAt,
    downloadAndInstall,
    dismiss,
    devSetState,
  };
}
