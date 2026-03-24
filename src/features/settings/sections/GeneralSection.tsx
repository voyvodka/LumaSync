import { useEffect, useRef, useState } from "react";
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
  openCalibration: () => void,
): void {
  if (lockState.showOpenCalibrationAction) openCalibration();
}

interface GeneralSectionProps {
  mode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onOpenCalibration: () => void;
}

interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

const SOLID_COMMIT_MIN_INTERVAL_MS = 50;

function isSameSolidDraft(left: SolidDraft, right: SolidDraft): boolean {
  return (
    left.r === right.r &&
    left.g === right.g &&
    left.b === right.b &&
    Math.abs(left.brightness - right.brightness) < 0.001
  );
}

function isSameTargetSet(a: HueRuntimeTarget[], b: HueRuntimeTarget[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((t) => set.has(t));
}

function toHexPair(value: number): string {
  return Math.max(0, Math.min(255, Math.floor(value))).toString(16).padStart(2, "0");
}

function toHexColor(mode: LightingModeConfig): string {
  const normalized = normalizeLightingModeConfig(mode);
  if (normalized.kind !== LIGHTING_MODE_KIND.SOLID || !normalized.solid) return "#ffffff";
  return `#${toHexPair(normalized.solid.r)}${toHexPair(normalized.solid.g)}${toHexPair(normalized.solid.b)}`;
}

function parseHexColor(value: string): { r: number; g: number; b: number } {
  const safe = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(safe)) return { r: 255, g: 255, b: 255 };
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
  isModeTransitioning = false,
  onModeChange,
  onOutputTargetsChange,
  onOpenCalibration,
}: GeneralSectionProps) {
  const { t } = useTranslation("common");
  const lockState = getGeneralModeLockState(modeLockReason);
  const modeSelectorDisabled = lockState.showReason || isModeTransitioning;
  const solidControlsDisabled = lockState.showReason;
  const normalizedMode = normalizeLightingModeConfig(mode);
  const incomingSolid: SolidDraft = normalizedMode.solid ?? { r: 255, g: 255, b: 255, brightness: 1 };
  const [solidDraft, setSolidDraft] = useState<SolidDraft>(incomingSolid);
  const solidCommitTimerRef = useRef<number | null>(null);
  const pendingSolidCommitRef = useRef<SolidDraft | null>(null);
  const lastSolidCommitAtRef = useRef(0);

  useEffect(() => {
    if (pendingSolidCommitRef.current) return;
    setSolidDraft((prev) => (isSameSolidDraft(prev, incomingSolid) ? prev : incomingSolid));
  }, [incomingSolid.brightness, incomingSolid.b, incomingSolid.g, incomingSolid.r]);

  useEffect(() => {
    return () => {
      if (solidCommitTimerRef.current !== null) window.clearTimeout(solidCommitTimerRef.current);
    };
  }, []);

  const flushSolidCommit = (payload: SolidDraft) => {
    lastSolidCommitAtRef.current = Date.now();
    pendingSolidCommitRef.current = null;
    onModeChange({ kind: LIGHTING_MODE_KIND.SOLID, solid: payload });
  };

  const queueSolidCommit = (payload: SolidDraft) => {
    pendingSolidCommitRef.current = payload;
    const elapsed = Date.now() - lastSolidCommitAtRef.current;
    const waitMs = Math.max(0, SOLID_COMMIT_MIN_INTERVAL_MS - elapsed);
    if (solidCommitTimerRef.current !== null) {
      window.clearTimeout(solidCommitTimerRef.current);
      solidCommitTimerRef.current = null;
    }
    if (waitMs === 0) { flushSolidCommit(payload); return; }
    solidCommitTimerRef.current = window.setTimeout(() => {
      solidCommitTimerRef.current = null;
      const latest = pendingSolidCommitRef.current;
      if (latest) flushSolidCommit(latest);
    }, waitMs);
  };

  const activeKind = normalizedMode.kind;
  const isOff = activeKind === LIGHTING_MODE_KIND.OFF;
  const isAmbilight = activeKind === LIGHTING_MODE_KIND.AMBILIGHT;
  const isSolid = activeKind === LIGHTING_MODE_KIND.SOLID;
  const solidHexColor = toHexColor(normalizedMode);
  const solidBrightnessPercent = Math.round(solidDraft.brightness * 100);
  const solidActiveAlpha = (0.3 + solidDraft.brightness * 0.7).toFixed(3);
  const solidTrackColor = `rgba(${solidDraft.r}, ${solidDraft.g}, ${solidDraft.b}, ${solidActiveAlpha})`;
  const solidTrackRemainder = `rgba(${solidDraft.r}, ${solidDraft.g}, ${solidDraft.b}, 0.18)`;

  return (
    <div className="w-full space-y-5">
      {/* Calibration required banner */}
      {lockState.showReason && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-300/60 bg-amber-50/80 px-4 py-3 dark:border-amber-700/60 dark:bg-amber-950/30">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            {t("general.mode.lockedReasonCalibration")}
          </p>
          <button
            type="button"
            className="shrink-0 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400"
            onClick={onOpenCalibration}
          >
            {t("general.mode.openCalibration")}
          </button>
        </div>
      )}

      {/* Output targets */}
      <div className="rounded-xl border border-slate-200/80 bg-white/90 dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="border-b border-slate-100 px-5 py-3.5 dark:border-zinc-800/70">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("general.output.title")}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
            {t("general.output.description")}
          </p>
        </div>
        <div className="flex gap-2 px-5 py-4">
          {(
            [
              { targets: ["usb"] as HueRuntimeTarget[], label: t("general.output.options.usb") },
              { targets: ["hue"] as HueRuntimeTarget[], label: t("general.output.options.hue") },
              { targets: ["usb", "hue"] as HueRuntimeTarget[], label: t("general.output.options.usbHue") },
            ] as const
          ).map(({ targets, label }) => {
            const isActive = isSameTargetSet(outputTargets, targets);
            return (
              <button
                key={label}
                type="button"
                disabled={modeSelectorDisabled}
                onClick={() => onOutputTargetsChange([...targets])}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                  isActive
                    ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* LED mode */}
      <div className="rounded-xl border border-slate-200/80 bg-white/90 dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="border-b border-slate-100 px-5 py-3.5 dark:border-zinc-800/70">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("general.mode.title")}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
            {t("general.mode.description")}
          </p>
        </div>
        <div className="flex gap-2 px-5 py-4">
          {(
            [
              {
                kind: LIGHTING_MODE_KIND.OFF,
                active: isOff,
                label: t("general.mode.options.off"),
                onClick: () => onModeChange({ kind: LIGHTING_MODE_KIND.OFF }),
              },
              {
                kind: LIGHTING_MODE_KIND.AMBILIGHT,
                active: isAmbilight,
                label: t("general.mode.options.ambilight"),
                onClick: () =>
                  onModeChange({
                    kind: LIGHTING_MODE_KIND.AMBILIGHT,
                    ambilight: { brightness: normalizedMode.ambilight?.brightness ?? 1 },
                  }),
              },
              {
                kind: LIGHTING_MODE_KIND.SOLID,
                active: isSolid,
                label: t("general.mode.options.solid"),
                onClick: () =>
                  onModeChange({
                    kind: LIGHTING_MODE_KIND.SOLID,
                    solid: { r: solidDraft.r, g: solidDraft.g, b: solidDraft.b, brightness: solidDraft.brightness },
                  }),
              },
            ] as const
          ).map(({ kind, active, label, onClick }) => (
            <button
              key={kind}
              type="button"
              disabled={modeSelectorDisabled}
              aria-pressed={active}
              onClick={onClick}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                active
                  ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Solid color controls */}
        {isSolid && (
          <div className="border-t border-slate-100 px-5 py-4 dark:border-zinc-800/70">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Color picker */}
              <div>
                <p className="mb-2 text-xs font-medium text-slate-600 dark:text-zinc-300">
                  {t("general.mode.solidColor")}
                  <span className="ml-2 font-mono text-slate-900 dark:text-zinc-100">
                    {solidHexColor.toUpperCase()}
                  </span>
                </p>
                <div
                  className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-zinc-700"
                  style={{
                    background: `linear-gradient(135deg, rgba(${solidDraft.r}, ${solidDraft.g}, ${solidDraft.b}, 0.18) 0%, transparent 100%)`,
                  }}
                >
                  <input
                    type="color"
                    aria-label={t("general.mode.solidColor")}
                    disabled={solidControlsDisabled}
                    value={solidHexColor}
                    className="h-9 w-14 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600"
                    onChange={(e) => {
                      const nextColor = parseHexColor(e.currentTarget.value);
                      const next = { ...solidDraft, ...nextColor };
                      setSolidDraft(next);
                      queueSolidCommit(next);
                    }}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-800 dark:text-zinc-100">
                      {t("general.mode.colorModelRgb")}
                    </p>
                    <p className="text-xs tabular-nums text-slate-500 dark:text-zinc-400">
                      {solidDraft.r}, {solidDraft.g}, {solidDraft.b}
                    </p>
                  </div>
                </div>
              </div>

              {/* Brightness */}
              <div>
                <p className="mb-2 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
                  <span>{t("general.mode.brightness")}</span>
                  <span className="tabular-nums text-slate-900 dark:text-zinc-100">
                    {solidBrightnessPercent}%
                  </span>
                </p>
                <div className="flex items-center rounded-lg border border-slate-200 px-3 py-3.5 dark:border-zinc-700">
                  <div className="w-full">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      disabled={solidControlsDisabled}
                      aria-label={t("general.mode.brightness")}
                      value={solidBrightnessPercent}
                      className="h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-60"
                      style={{
                        accentColor: solidTrackColor,
                        background: `linear-gradient(to right, ${solidTrackColor} 0%, ${solidTrackColor} ${solidBrightnessPercent}%, ${solidTrackRemainder} ${solidBrightnessPercent}%, ${solidTrackRemainder} 100%)`,
                      }}
                      onChange={(e) => {
                        const nextBrightness = Number.parseInt(e.currentTarget.value, 10) / 100;
                        const next = {
                          ...solidDraft,
                          brightness: Number.isFinite(nextBrightness) ? nextBrightness : solidDraft.brightness,
                        };
                        setSolidDraft(next);
                        queueSolidCommit(next);
                      }}
                    />
                    <div className="mt-1.5 flex justify-between text-[10px] text-slate-400 dark:text-zinc-500">
                      <span>0%</span>
                      <span>100%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
