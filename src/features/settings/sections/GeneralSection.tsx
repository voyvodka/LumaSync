import { useTranslation } from "react-i18next";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "../../mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeAmbilightPayload,
  type LightingModeConfig,
} from "../../mode/model/contracts";
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";

import { CalibrationRequiredBanner } from "./control/CalibrationRequiredBanner";
import { OutputTargetsPanel } from "./control/OutputTargetsPanel";
import { ModeSelectorRow } from "./control/ModeSelectorRow";
import { SolidColorPanel } from "./control/SolidColorPanel";

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
  openCalibration: () => void,
): void {
  if (lockState.showOpenCalibrationAction) openCalibration();
}

interface GeneralSectionProps {
  mode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable?: boolean;
  hueStreaming: boolean;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onOpenCalibration: () => void;
}

export function GeneralSection({
  mode,
  outputTargets,
  usbConnected,
  hueConfigured,
  hueReachable = true,
  hueStreaming,
  modeLockReason,
  isModeTransitioning = false,
  onModeChange,
  onOutputTargetsChange,
  onOpenCalibration,
}: GeneralSectionProps) {
  const { t } = useTranslation("common");
  const lockState = getGeneralModeLockState(modeLockReason);
  const modeSelectorDisabled = lockState.showReason || isModeTransitioning;
  const normalizedMode = normalizeLightingModeConfig(mode);
  const activeKind = normalizedMode.kind;
  const isSolid = activeKind === LIGHTING_MODE_KIND.SOLID;
  const isAmbilight = activeKind === LIGHTING_MODE_KIND.AMBILIGHT;
  const incomingSolid = normalizedMode.solid ?? { r: 255, g: 255, b: 255, brightness: 1 };
  const incomingAmbilight = normalizeAmbilightPayload(normalizedMode.ambilight);

  return (
    <div className="w-full space-y-5">
      {lockState.showReason && (
        <CalibrationRequiredBanner onOpenCalibration={onOpenCalibration} />
      )}

      <OutputTargetsPanel
        outputTargets={outputTargets}
        usbConnected={usbConnected}
        hueConfigured={hueConfigured}
        hueReachable={hueReachable}
        hueStreaming={hueStreaming}
        disabled={modeSelectorDisabled}
        onOutputTargetsChange={onOutputTargetsChange}
      />

      <div className="rounded-xl border border-slate-200/80 bg-white/90 dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="border-b border-slate-100 px-5 py-3.5 dark:border-zinc-800/70">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("general.mode.title")}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
            {t("general.mode.description")}
          </p>
        </div>
        <div className="px-5 py-4">
          <ModeSelectorRow
            activeKind={activeKind}
            disabled={modeSelectorDisabled}
            ambilightConfig={incomingAmbilight}
            solidDraft={incomingSolid}
            onModeChange={onModeChange}
          />
        </div>
        <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${
          isSolid ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}>
          <div className="overflow-hidden">
            <div className="border-t border-slate-100 px-5 py-4 dark:border-zinc-800/70">
              <SolidColorPanel
                incoming={incomingSolid}
                disabled={lockState.showReason}
                onCommit={(draft) =>
                  onModeChange({ kind: LIGHTING_MODE_KIND.SOLID, solid: draft })
                }
              />
            </div>
          </div>
        </div>
        <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${
          isAmbilight ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}>
          <div className="overflow-hidden">
            <div className="border-t border-slate-100 px-5 py-4 dark:border-zinc-800/70">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
                    {t("general.mode.ambilight.blackBorderTitle")}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                    {t("general.mode.ambilight.blackBorderDescription")}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={lockState.showReason}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600 disabled:cursor-not-allowed disabled:opacity-50 ${
                    incomingAmbilight.blackBorderDetection
                      ? "bg-slate-900 dark:bg-zinc-100"
                      : "bg-slate-300 dark:bg-zinc-700"
                  }`}
                  onClick={() =>
                    onModeChange({
                      kind: LIGHTING_MODE_KIND.AMBILIGHT,
                      ambilight: {
                        ...incomingAmbilight,
                        blackBorderDetection: !incomingAmbilight.blackBorderDetection,
                      },
                    })
                  }
                  aria-pressed={incomingAmbilight.blackBorderDetection}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform dark:bg-zinc-900 ${
                      incomingAmbilight.blackBorderDetection ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
