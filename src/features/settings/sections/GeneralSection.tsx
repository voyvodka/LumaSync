import { useTranslation } from "react-i18next";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "../../mode/state/modeGuard";

export interface GeneralModeLockState {
  reason: ModeGuardReason | null;
  showReason: boolean;
  showOpenCalibrationAction: boolean;
}

export function getGeneralModeLockState(reason: ModeGuardReason | null): GeneralModeLockState {
  const calibrationRequired = reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  return {
    reason,
    showReason: calibrationRequired,
    showOpenCalibrationAction: calibrationRequired,
  };
}

export function triggerCalibrationFromLock(
  lockState: GeneralModeLockState,
  openCalibrationOverlay: () => void,
): void {
  if (lockState.showOpenCalibrationAction) {
    openCalibrationOverlay();
  }
}

interface GeneralSectionProps {
  ledModeEnabled: boolean;
  modeLockReason: ModeGuardReason | null;
  onLedModeChange: (nextEnabled: boolean) => void;
  onOpenCalibrationOverlay: () => void;
}

export function GeneralSection({
  ledModeEnabled,
  modeLockReason,
  onLedModeChange,
  onOpenCalibrationOverlay,
}: GeneralSectionProps) {
  const { t } = useTranslation("common");
  const lockState = getGeneralModeLockState(modeLockReason);
  const modeToggleDisabled = lockState.showReason;

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("general.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">
        {t("general.description")}
      </p>

      <div className="mt-6 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{t("general.mode.title")}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{t("general.mode.description")}</p>
          </div>
          <button
            type="button"
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600 ${
              ledModeEnabled
                ? "bg-slate-900 dark:bg-zinc-100"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            disabled={modeToggleDisabled}
            aria-disabled={modeToggleDisabled}
            aria-pressed={ledModeEnabled}
            aria-label={t("general.mode.toggleLabel")}
            onClick={() => {
              onLedModeChange(!ledModeEnabled);
            }}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform dark:bg-zinc-900 ${
                ledModeEnabled ? "translate-x-5" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {lockState.showReason ? (
          <div className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50/80 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
            <p>{t("general.mode.lockedReasonCalibration")}</p>
            <button
              type="button"
              className="mt-2 inline-flex items-center rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400"
              onClick={() => {
                triggerCalibrationFromLock(lockState, onOpenCalibrationOverlay);
              }}
            >
              {t("general.mode.openCalibration")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
