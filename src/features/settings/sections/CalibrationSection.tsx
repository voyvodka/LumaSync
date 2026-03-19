import { useTranslation } from "react-i18next";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";

interface CalibrationSectionProps {
  calibration?: LedCalibrationConfig;
  onEdit: () => void;
}

export function CalibrationSection({ calibration, onEdit }: CalibrationSectionProps) {
  const { t } = useTranslation("common");

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("calibration.section.title")}</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
        {t("calibration.section.description")}
      </p>

      <dl className="mt-6 grid gap-4 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-800/40 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.template")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">
            {calibration?.templateId ?? t("calibration.section.notConfigured")}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.totalLeds")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">
            {calibration?.totalLeds ?? 0}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onEdit}
        className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        {t("calibration.section.edit")}
      </button>
    </section>
  );
}
