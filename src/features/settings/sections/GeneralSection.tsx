import { useTranslation } from "react-i18next";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "../../mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  type LightingModeConfig,
} from "../../mode/model/contracts";
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";

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
  mode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  modeLockReason: ModeGuardReason | null;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onOpenCalibrationOverlay: () => void;
}

function isSameTargetSet(currentTargets: HueRuntimeTarget[], expectedTargets: HueRuntimeTarget[]): boolean {
  if (currentTargets.length !== expectedTargets.length) {
    return false;
  }

  const currentSet = new Set(currentTargets);
  return expectedTargets.every((target) => currentSet.has(target));
}

function toHexPair(value: number): string {
  return Math.max(0, Math.min(255, Math.floor(value))).toString(16).padStart(2, "0");
}

function toHexColor(mode: LightingModeConfig): string {
  const normalized = normalizeLightingModeConfig(mode);
  if (normalized.kind !== LIGHTING_MODE_KIND.SOLID || !normalized.solid) {
    return "#ffffff";
  }

  return `#${toHexPair(normalized.solid.r)}${toHexPair(normalized.solid.g)}${toHexPair(normalized.solid.b)}`;
}

function parseHexColor(value: string): { r: number; g: number; b: number } {
  const safe = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(safe)) {
    return { r: 255, g: 255, b: 255 };
  }

  return {
    r: Number.parseInt(safe.slice(0, 2), 16),
    g: Number.parseInt(safe.slice(2, 4), 16),
    b: Number.parseInt(safe.slice(4, 6), 16),
  };
}

export function GeneralSection({
  mode,
  outputTargets,
  modeLockReason,
  onModeChange,
  onOutputTargetsChange,
  onOpenCalibrationOverlay,
}: GeneralSectionProps) {
  const { t } = useTranslation("common");
  const lockState = getGeneralModeLockState(modeLockReason);
  const modeSelectorDisabled = lockState.showReason;
  const normalizedMode = normalizeLightingModeConfig(mode);
  const solidPayload = normalizedMode.solid ?? {
    r: 255,
    g: 255,
    b: 255,
    brightness: 1,
  };

  const activeKind = normalizedMode.kind;
  const isOff = activeKind === LIGHTING_MODE_KIND.OFF;
  const isAmbilight = activeKind === LIGHTING_MODE_KIND.AMBILIGHT;
  const isSolid = activeKind === LIGHTING_MODE_KIND.SOLID;
  const solidHexColor = toHexColor(normalizedMode);
  const solidBrightnessPercent = Math.round(solidPayload.brightness * 100);
  const solidActiveAlpha = (0.3 + (solidPayload.brightness * 0.7)).toFixed(3);
  const solidTrackColor = `rgba(${solidPayload.r}, ${solidPayload.g}, ${solidPayload.b}, ${solidActiveAlpha})`;
  const solidTrackRemainder = `rgba(${solidPayload.r}, ${solidPayload.g}, ${solidPayload.b}, 0.18)`;

  return (
    <section className="w-full rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("general.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">
        {t("general.description")}
      </p>

      <div className="mt-6 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{t("general.output.title")}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{t("general.output.description")}</p>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isSameTargetSet(outputTargets, ["usb"])
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            }`}
            onClick={() => onOutputTargetsChange(["usb"])}
          >
            {t("general.output.options.usb")}
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isSameTargetSet(outputTargets, ["hue"])
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            }`}
            onClick={() => onOutputTargetsChange(["hue"])}
          >
            {t("general.output.options.hue")}
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isSameTargetSet(outputTargets, ["usb", "hue"])
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            }`}
            onClick={() => onOutputTargetsChange(["usb", "hue"])}
          >
            {t("general.output.options.usbHue")}
          </button>
        </div>

        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{t("general.mode.title")}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{t("general.mode.description")}</p>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isOff
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            }`}
            aria-pressed={isOff}
            onClick={() => onModeChange({ kind: LIGHTING_MODE_KIND.OFF })}
          >
            {t("general.mode.options.off")}
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isAmbilight
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            }`}
            disabled={modeSelectorDisabled}
            aria-disabled={modeSelectorDisabled}
            aria-pressed={isAmbilight}
            onClick={() =>
              onModeChange({
                kind: LIGHTING_MODE_KIND.AMBILIGHT,
                ambilight: {
                  brightness: normalizedMode.ambilight?.brightness ?? 1,
                },
              })
            }
          >
            {t("general.mode.options.ambilight")}
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isSolid
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            }`}
            disabled={modeSelectorDisabled}
            aria-disabled={modeSelectorDisabled}
            aria-pressed={isSolid}
            onClick={() =>
              onModeChange({
                kind: LIGHTING_MODE_KIND.SOLID,
                solid: {
                  r: solidPayload.r,
                  g: solidPayload.g,
                  b: solidPayload.b,
                  brightness: solidPayload.brightness,
                },
              })
            }
          >
            {t("general.mode.options.solid")}
          </button>
        </div>

        {isSolid ? (
          <div className="mt-4 grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2">
            <div className="flex h-full min-h-[132px] flex-col rounded-lg border border-slate-300/80 bg-white/80 px-3 py-3 dark:border-zinc-700 dark:bg-zinc-900/70">
              <div className="mb-2 flex items-center justify-between text-xs font-medium">
                <span className="text-slate-600 dark:text-zinc-300">{t("general.mode.solidColor")}</span>
                <span className="font-mono text-slate-900 dark:text-zinc-100">{solidHexColor.toUpperCase()}</span>
              </div>
              <div
                className="flex flex-1 items-center rounded-md border border-slate-200/80 p-2 dark:border-zinc-700"
                style={{
                  background: `linear-gradient(135deg, rgba(${solidPayload.r}, ${solidPayload.g}, ${solidPayload.b}, 0.26) 0%, rgba(${solidPayload.r}, ${solidPayload.g}, ${solidPayload.b}, 0.08) 100%)`,
                }}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    aria-label={t("general.mode.solidColor")}
                    disabled={modeSelectorDisabled}
                    value={solidHexColor}
                    className="h-10 w-16 cursor-pointer rounded-md border border-slate-300 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600"
                    onChange={(event) => {
                      const nextColor = parseHexColor(event.currentTarget.value);
                      onModeChange({
                        kind: LIGHTING_MODE_KIND.SOLID,
                        solid: {
                          ...solidPayload,
                          ...nextColor,
                        },
                      });
                    }}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-800 dark:text-zinc-100">RGB</p>
                    <p className="text-xs text-slate-600 dark:text-zinc-300">
                      {solidPayload.r}, {solidPayload.g}, {solidPayload.b}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex h-full min-h-[132px] flex-col rounded-lg border border-slate-300/80 bg-white/80 px-3 py-3 dark:border-zinc-700 dark:bg-zinc-900/70">
              <div className="mb-2 flex items-center justify-between text-xs font-medium">
                <span className="text-slate-600 dark:text-zinc-300">{t("general.mode.brightness")}</span>
                <span className="tabular-nums text-slate-900 dark:text-zinc-100">
                  {solidBrightnessPercent}%
                </span>
              </div>
              <div className="flex flex-1 items-center rounded-md border border-slate-200/80 px-2 py-3 dark:border-zinc-700">
                <div className="w-full">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    disabled={modeSelectorDisabled}
                    aria-label={t("general.mode.brightness")}
                    value={solidBrightnessPercent}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-60"
                    style={{
                      accentColor: solidTrackColor,
                      background: `linear-gradient(to right, ${solidTrackColor} 0%, ${solidTrackColor} ${solidBrightnessPercent}%, ${solidTrackRemainder} ${solidBrightnessPercent}%, ${solidTrackRemainder} 100%)`,
                    }}
                    onChange={(event) => {
                      const nextBrightness = Number.parseInt(event.currentTarget.value, 10) / 100;
                      onModeChange({
                        kind: LIGHTING_MODE_KIND.SOLID,
                        solid: {
                          ...solidPayload,
                          brightness: Number.isFinite(nextBrightness) ? nextBrightness : solidPayload.brightness,
                        },
                      });
                    }}
                  />
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-zinc-400">
                    <span>0%</span>
                    <span>100%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

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
