import { useTranslation } from "react-i18next";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdaterState } from "./useAutoUpdater";

interface UpdateModalProps {
  state: UpdaterState;
  onInstall: (update: Update) => void;
  onDismiss: () => void;
}

export function UpdateModal({ state, onInstall, onDismiss }: UpdateModalProps) {
  const { t } = useTranslation("common");

  if (state.status !== "available" && state.status !== "downloading" && state.status !== "installing" && state.status !== "error") {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
          {t("updater.title")}
        </h2>

        {state.status === "available" && (
          <>
            <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
              {t("updater.available", { version: state.update.version })}
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {t("updater.later")}
              </button>
              <button
                type="button"
                onClick={() => onInstall(state.update)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {t("updater.install")}
              </button>
            </div>
          </>
        )}

        {state.status === "downloading" && (
          <>
            <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
              {t("updater.downloading", { progress: state.progress })}
            </p>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-zinc-700">
              <div
                className="h-full rounded-full bg-slate-900 transition-all dark:bg-zinc-100"
                style={{ width: `${state.progress}%` }}
              />
            </div>
          </>
        )}

        {state.status === "installing" && (
          <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
            {t("updater.installing")}
          </p>
        )}

        {state.status === "error" && (
          <>
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              {t("updater.error", { message: state.message })}
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {t("updater.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
