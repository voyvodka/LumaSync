import { useState, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdaterState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; update: Update }
  | { status: "downloading"; progress: number }
  | { status: "installing" }
  | { status: "error"; message: string };

export function useAutoUpdater() {
  const [state, setState] = useState<UpdaterState>({ status: "idle" });

  const checkForUpdates = useCallback(async () => {
    setState({ status: "checking" });
    try {
      const update = await check();
      if (update) {
        setState({ status: "available", update });
      } else {
        setState({ status: "idle" });
      }
    } catch {
      setState({ status: "idle" });
    }
  }, []);

  const downloadAndInstall = useCallback(async (update: Update) => {
    try {
      let downloaded = 0;
      let total = 0;

      setState({ status: "downloading", progress: 0 });

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          setState({ status: "downloading", progress });
        } else if (event.event === "Finished") {
          setState({ status: "installing" });
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

  return { state, checkForUpdates, downloadAndInstall, dismiss };
}
