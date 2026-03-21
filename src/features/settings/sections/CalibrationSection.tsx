import { useTranslation } from "react-i18next";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { CALIBRATION_TEMPLATES } from "../../calibration/model/templates";

interface CalibrationSectionProps {
  calibration?: LedCalibrationConfig;
  onEditCalibration: () => void;
}

export function CalibrationSection({ calibration, onEditCalibration }: CalibrationSectionProps) {
  const { t } = useTranslation("common");
  const isConfigured = Boolean(calibration);
  const templateLabel = calibration?.templateId
    ? CALIBRATION_TEMPLATES.find((template) => template.id === calibration.templateId)?.label ?? calibration.templateId
    : calibration
      ? t("calibration.section.manual")
      : t("calibration.section.notConfigured");
  const edgeSummary = calibration
    ? [
        `${t("calibration.section.counts.top")} ${calibration.counts.top}`,
        `${t("calibration.section.counts.right")} ${calibration.counts.right}`,
        `${t("calibration.section.counts.bottom")} ${calibration.counts.bottom}`,
        `${t("calibration.section.counts.left")} ${calibration.counts.left}`,
      ].join(" • ")
    : t("calibration.section.notConfigured");
  const directionValue = calibration
    ? t(`calibration.editor.directions.${calibration.direction}`)
    : t("calibration.section.notConfigured");
  const missingValue = calibration ? String(calibration.bottomMissing) : t("calibration.section.notConfigured");
  const cornerOwnershipValue = calibration
    ? calibration.cornerOwnership === "vertical"
      ? t("calibration.section.cornerOwnershipVertical")
      : t("calibration.section.cornerOwnershipHorizontal")
    : t("calibration.section.notConfigured");
  const startAnchorValue = calibration
    ? t(`calibration.editor.startAnchors.${calibration.startAnchor}`)
    : t("calibration.section.notConfigured");

  return (
    <section className="w-full rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("calibration.section.title")}</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
        {t("calibration.section.description")}
      </p>

      {!isConfigured ? (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-100">
          {t("calibration.section.emptyState")}
        </p>
      ) : null}

      <dl className="mt-6 grid gap-4 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-800/40 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.template")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">{templateLabel}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.totalLeds")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">
            {calibration?.totalLeds ?? t("calibration.section.notConfigured")}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.edges")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">{edgeSummary}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.gap")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">{missingValue}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.startAnchor")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">{startAnchorValue}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.cornerOwnership")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">{cornerOwnershipValue}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("calibration.section.direction")}
          </dt>
          <dd className="mt-1 text-slate-900 dark:text-zinc-100">{directionValue}</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onEditCalibration}
        className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        {t("calibration.section.edit")}
      </button>
    </section>
  );
}
