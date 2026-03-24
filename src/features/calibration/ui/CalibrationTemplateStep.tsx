import { useTranslation } from "react-i18next";

import { CALIBRATION_TEMPLATES } from "../model/templates";

interface CalibrationTemplateStepProps {
  selectedTemplateId?: string;
  onSelectTemplate: (templateId: string) => void;
}

export function CalibrationTemplateStep({
  selectedTemplateId,
  onSelectTemplate,
}: CalibrationTemplateStepProps) {
  const { t } = useTranslation("common");

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900/95 sm:p-8">
      <h2 className="text-xl font-semibold text-slate-900 dark:text-zinc-100">
        {t("calibration.template.title")}
      </h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
        {t("calibration.template.description")}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {CALIBRATION_TEMPLATES.map((template) => {
          const selected = selectedTemplateId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelectTemplate(template.id)}
              className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                selected
                  ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-slate-300 bg-white text-slate-900 hover:border-slate-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500"
              }`}
            >
              <p className="text-sm font-semibold">{template.label}</p>
              <p className={`mt-1 text-xs ${selected ? "text-white/80 dark:text-zinc-700" : "text-slate-500 dark:text-zinc-400"}`}>
                {t("calibration.template.ledCount", {
                  count: template.counts.top +
                    template.counts.right +
                    template.counts.bottom +
                    template.counts.left,
                })}
              </p>
            </button>
          );
        })}
      </div>

    </section>
  );
}
