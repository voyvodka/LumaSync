import { useTranslation } from "react-i18next";

interface CalibrationRequiredBannerProps {
  onOpenCalibration: () => void;
}

export function CalibrationRequiredBanner({ onOpenCalibration }: CalibrationRequiredBannerProps) {
  const { t } = useTranslation("common");

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 dark:border-amber-700/60 dark:bg-amber-950/30">
      <p className="text-sm text-amber-900 dark:text-amber-200">
        {t("general.mode.lockedReasonCalibration")}
      </p>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-800 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900"
        onClick={onOpenCalibration}
      >
        {t("general.mode.openCalibration")}
      </button>
    </div>
  );
}
