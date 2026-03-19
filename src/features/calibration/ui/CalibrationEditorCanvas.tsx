import { useTranslation } from "react-i18next";

import type {
  LedCalibrationConfig,
  LedDirection,
  LedStartAnchor,
} from "../model/contracts";

interface CalibrationEditorCanvasProps {
  config: LedCalibrationConfig;
  isDirty: boolean;
  onCountChange: (segment: "top" | "left" | "right" | "bottomLeft" | "bottomRight", value: number) => void;
  onStartAnchorChange: (anchor: LedStartAnchor) => void;
  onDirectionChange: (direction: LedDirection) => void;
  onResetTemplate: () => void;
}

const START_ANCHORS: LedStartAnchor[] = [
  "top-start",
  "top-end",
  "left-start",
  "left-end",
  "right-start",
  "right-end",
  "bottom-left-start",
  "bottom-left-end",
  "bottom-right-start",
  "bottom-right-end",
];

export function CalibrationEditorCanvas({
  config,
  isDirty,
  onCountChange,
  onStartAnchorChange,
  onDirectionChange,
  onResetTemplate,
}: CalibrationEditorCanvasProps) {
  const { t } = useTranslation("common");

  const countFields: Array<{ key: "top" | "left" | "right" | "bottomLeft" | "bottomRight"; labelKey: string }> = [
    { key: "top", labelKey: "calibration.editor.counts.top" },
    { key: "left", labelKey: "calibration.editor.counts.left" },
    { key: "right", labelKey: "calibration.editor.counts.right" },
    { key: "bottomLeft", labelKey: "calibration.editor.counts.bottomLeft" },
    { key: "bottomRight", labelKey: "calibration.editor.counts.bottomRight" },
  ];

  return (
    <section className="mx-auto w-full max-w-4xl rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900/95 sm:p-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-zinc-100">
            {t("calibration.editor.title")}
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
            {t("calibration.editor.description")}
          </p>
        </div>

        <span
          className={`rounded-md px-2 py-1 text-xs font-semibold ${
            isDirty
              ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
          }`}
        >
          {isDirty ? t("calibration.editor.dirty") : t("calibration.editor.saved")}
        </span>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {countFields.map((field) => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
              {t(field.labelKey)}
            </span>
            <input
              type="number"
              min={0}
              value={config.counts[field.key]}
              onChange={(event) => {
                onCountChange(field.key, Number(event.target.value));
              }}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
        ))}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
            {t("calibration.editor.startAnchor")}
          </span>
          <select
            value={config.startAnchor}
            onChange={(event) => {
              onStartAnchorChange(event.target.value as LedStartAnchor);
            }}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {START_ANCHORS.map((anchor) => (
              <option key={anchor} value={anchor}>
                {anchor}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
            {t("calibration.editor.direction")}
          </span>
          <select
            value={config.direction}
            onChange={(event) => {
              onDirectionChange(event.target.value as LedDirection);
            }}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="cw">CW</option>
            <option value="ccw">CCW</option>
          </select>
        </label>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800/50">
        <p className="text-slate-700 dark:text-zinc-200">
          {t("calibration.editor.totalLeds", { count: config.totalLeds })}
        </p>
        <button
          type="button"
          onClick={onResetTemplate}
          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:border-slate-900 hover:bg-slate-900 hover:text-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
        >
          {t("calibration.editor.changeTemplate")}
        </button>
      </div>
    </section>
  );
}
