import { useTranslation } from "react-i18next";

import type {
  CornerOwnership,
  LedCalibrationConfig,
  LedDirection,
  LedStartAnchor,
  LedVisualPreset,
} from "../model/contracts";

interface CalibrationEditorCanvasProps {
  config: LedCalibrationConfig;
  isDirty: boolean;
  onCountChange: (segment: "top" | "right" | "bottom" | "left", value: number) => void;
  onBottomMissingChange: (count: number) => void;
  onCornerOwnershipChange: (ownership: CornerOwnership) => void;
  onVisualPresetChange: (preset: LedVisualPreset) => void;
  onStartAnchorChange: (anchor: LedStartAnchor) => void;
  onDirectionChange: (direction: LedDirection) => void;
  onResetTemplate: () => void;
}

const BASE_START_ANCHORS: LedStartAnchor[] = [
  "top-start",
  "top-end",
  "right-start",
  "right-end",
  "bottom-start",
  "bottom-end",
  "left-start",
  "left-end",
];

const GAP_START_ANCHORS: LedStartAnchor[] = ["bottom-gap-right", "bottom-gap-left"];

export function CalibrationEditorCanvas({
  config,
  isDirty,
  onCountChange,
  onBottomMissingChange,
  onCornerOwnershipChange,
  onVisualPresetChange,
  onStartAnchorChange,
  onDirectionChange,
  onResetTemplate,
}: CalibrationEditorCanvasProps) {
  const { t } = useTranslation("common");
  const startAnchorOptions =
    config.bottomMissing > 0 ? [...BASE_START_ANCHORS, ...GAP_START_ANCHORS] : BASE_START_ANCHORS;

  const countFields: Array<{ key: "top" | "right" | "bottom" | "left"; labelKey: string }> = [
    { key: "top", labelKey: "calibration.editor.counts.top" },
    { key: "right", labelKey: "calibration.editor.counts.right" },
    { key: "bottom", labelKey: "calibration.editor.counts.bottom" },
    { key: "left", labelKey: "calibration.editor.counts.left" },
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

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
            {t("calibration.editor.bottomMissing")}
          </span>
          <input
            type="number"
            min={0}
            value={config.bottomMissing}
            onChange={(event) => {
              const value = Number(event.target.value);
              onBottomMissingChange(Number.isFinite(value) ? Math.max(0, value) : 0);
            }}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
            {t("calibration.editor.cornerOwnership")}
          </span>
          <select
            value={config.cornerOwnership}
            onChange={(event) => {
              onCornerOwnershipChange(event.target.value as CornerOwnership);
            }}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="horizontal">{t("calibration.editor.cornerOwnershipHorizontal")}</option>
            <option value="vertical">{t("calibration.editor.cornerOwnershipVertical")}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
            {t("calibration.editor.visualPreset")}
          </span>
          <select
            value={config.visualPreset}
            onChange={(event) => {
              onVisualPresetChange(event.target.value as LedVisualPreset);
            }}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="subtle">{t("calibration.editor.visualPresets.subtle")}</option>
            <option value="vivid">{t("calibration.editor.visualPresets.vivid")}</option>
          </select>
        </label>
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
            {startAnchorOptions.map((anchor) => (
              <option key={anchor} value={anchor}>
                {t(`calibration.editor.startAnchors.${anchor}`)}
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
            <option value="cw">{t("calibration.editor.directions.cw")}</option>
            <option value="ccw">{t("calibration.editor.directions.ccw")}</option>
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
