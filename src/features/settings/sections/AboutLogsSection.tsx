import { useTranslation } from "react-i18next";
import { APP_NAME, APP_VERSION } from "../../../shared/constants/app";

export function AboutLogsSection() {
  const { t } = useTranslation("common");

  return (
    <section className="w-full rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("aboutLogs.title")}</h2>

      <div className="mt-6 divide-y divide-slate-200/80 dark:divide-zinc-800">
        <div className="py-4">
          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{APP_NAME}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{t("aboutLogs.version")} {APP_VERSION}</p>
        </div>

        <div className="py-4">
          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{t("aboutLogs.logs")}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{t("aboutLogs.logsDescription")}</p>
        </div>
      </div>
    </section>
  );
}
