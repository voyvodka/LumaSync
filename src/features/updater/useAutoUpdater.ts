import { useState, useCallback, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; update: Update }
  | {
      status: "downloading";
      update: Update;
      progress: number;
      downloadedBytes: number;
      totalBytes: number;
      bytesPerSecond: number;
      etaSeconds: number | null;
    }
  | { status: "installing"; update: Update }
  | { status: "error"; message: string };

export function useAutoUpdater() {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  const lastStartRef = useRef<number>(0);
  const lastBytesRef = useRef<number>(0);

  const checkForUpdates = useCallback(async () => {
    setState({ status: "checking" });
    try {
      const update = await check();
      if (update) {
        setState({ status: "available", update });
      } else {
        setState({ status: "idle" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", message });
    }
  }, []);

  const downloadAndInstall = useCallback(async (update: Update) => {
    try {
      let downloaded = 0;
      let total = 0;
      lastStartRef.current = Date.now();
      lastBytesRef.current = 0;

      setState({
        status: "downloading",
        update,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        etaSeconds: null,
      });

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          lastStartRef.current = Date.now();
          lastBytesRef.current = 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const elapsedMs = Math.max(1, Date.now() - lastStartRef.current);
          const bytesPerSecond = Math.round((downloaded / elapsedMs) * 1000);
          const remaining = total > 0 ? Math.max(0, total - downloaded) : 0;
          const etaSeconds =
            total > 0 && bytesPerSecond > 0 ? Math.max(0, Math.round(remaining / bytesPerSecond)) : null;
          const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          lastBytesRef.current = downloaded;
          setState({
            status: "downloading",
            update,
            progress,
            downloadedBytes: downloaded,
            totalBytes: total,
            bytesPerSecond,
            etaSeconds,
          });
        } else if (event.event === "Finished") {
          setState({ status: "installing", update });
        }
      });
      // App relaunches automatically after installation
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", message });
    }
  }, []);

  const dismiss = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  // Dev-only escape hatch for testing the 4 modal states without a real updater endpoint.
  // Kept permanently in DEV so the panel remains usable across sessions.
  const devSetState = useCallback((next: UpdaterState) => {
    if (!import.meta.env.DEV) return;
    setState(next);
  }, []);

  return { state, checkForUpdates, downloadAndInstall, dismiss, devSetState };
}
