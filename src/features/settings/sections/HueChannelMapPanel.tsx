import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueAreaChannelInfo } from "../../device/hueOnboardingApi";

const REGIONS = ["left", "right", "top", "bottom", "center"] as const;
type Region = (typeof REGIONS)[number];

interface Props {
  channels: HueAreaChannelInfo[];
  isLoading: boolean;
  overrides: Record<number, string>;
  onSetRegion: (channelIndex: number, region: string | null) => void;
}

/* ── Position helpers ── */

/** Convert Hue position (x: -1..+1, y: -1..+1) to CSS % inside the room viewport.
 *  Hue x: -1=left, +1=right -> left%
 *  Hue y: -1=bottom, +1=top -> we flip so top of box = top of screen */
function posToPercent(x: number, y: number): { left: number; top: number } {
  const cx = Math.max(-1, Math.min(1, x));
  const cy = Math.max(-1, Math.min(1, y));
  const left = ((cx + 1) / 2) * 100;
  const top = ((1 - cy) / 2) * 100;
  return { left, top };
}

/** Distance from center (0..1 normalized). Dots further from center are "closer to viewer"
 *  in the spatial metaphor — they render slightly larger. */
function distFromCenter(x: number, y: number): number {
  return Math.min(1, Math.sqrt(x * x + y * y));
}

/* ── Color system ── */

const REGION_COLOR: Record<Region, { dot: string; glow: string; bg: string; text: string }> = {
  left: {
    dot: "bg-blue-500",
    glow: "shadow-[0_0_8px_2px_rgba(59,130,246,0.55)]",
    bg: "bg-blue-500/10 hover:bg-blue-500/20",
    text: "text-blue-400",
  },
  right: {
    dot: "bg-violet-500",
    glow: "shadow-[0_0_8px_2px_rgba(139,92,246,0.55)]",
    bg: "bg-violet-500/10 hover:bg-violet-500/20",
    text: "text-violet-400",
  },
  top: {
    dot: "bg-emerald-500",
    glow: "shadow-[0_0_8px_2px_rgba(16,185,129,0.55)]",
    bg: "bg-emerald-500/10 hover:bg-emerald-500/20",
    text: "text-emerald-400",
  },
  bottom: {
    dot: "bg-amber-500",
    glow: "shadow-[0_0_8px_2px_rgba(245,158,11,0.55)]",
    bg: "bg-amber-500/10 hover:bg-amber-500/20",
    text: "text-amber-400",
  },
  center: {
    dot: "bg-slate-400 dark:bg-zinc-400",
    glow: "shadow-[0_0_8px_2px_rgba(148,163,184,0.35)]",
    bg: "bg-slate-400/10 hover:bg-slate-400/20",
    text: "text-slate-400",
  },
};

/** Zone overlay layout — 5 clickable regions mapped onto the spatial view.
 *  Expressed as CSS inset percentages: [top, right, bottom, left]. */
const ZONE_INSETS: Record<Region, { top: string; right: string; bottom: string; left: string }> = {
  top:    { top: "0%",  right: "20%", bottom: "70%", left: "20%" },
  bottom: { top: "70%", right: "20%", bottom: "0%",  left: "20%" },
  left:   { top: "20%", right: "70%", bottom: "20%", left: "0%" },
  right:  { top: "20%", right: "0%",  bottom: "20%", left: "70%" },
  center: { top: "30%", right: "30%", bottom: "30%", left: "30%" },
};

const SAVED_FLASH_MS = 2000;

export function HueChannelMapPanel({ channels, isLoading, overrides, onSetRegion }: Props) {
  const { t } = useTranslation();
  const [selectedDot, setSelectedDot] = useState<number | null>(null);
  const [savedChannelIndex, setSavedChannelIndex] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const regionLabel = useCallback(
    (region: string): string => {
      const key = `device.hue.channelMap.regions.${region}`;
      const translated = t(key);
      return translated === key ? region : translated;
    },
    [t],
  );

  const handleSetRegion = useCallback(
    (channelIndex: number, region: string | null) => {
      onSetRegion(channelIndex, region);
      setSavedChannelIndex(channelIndex);
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = setTimeout(() => {
        setSavedChannelIndex(null);
        savedTimerRef.current = null;
      }, SAVED_FLASH_MS);
    },
    [onSetRegion],
  );

  const handleZoneClick = useCallback(
    (region: Region) => {
      if (selectedDot === null) return;
      const ch = channels.find((c) => c.index === selectedDot);
      if (!ch) return;
      // If already this region via override, reset to auto
      const currentOverride = overrides[selectedDot];
      if (currentOverride === region) {
        handleSetRegion(selectedDot, null);
      } else if (ch.autoRegion === region && !currentOverride) {
        // Already auto-assigned to this region, no-op
        return;
      } else {
        handleSetRegion(selectedDot, region === ch.autoRegion ? null : region);
      }
    },
    [selectedDot, channels, overrides, handleSetRegion],
  );

  if (isLoading) {
    return (
      <div className="mt-4 rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-zinc-700/60 dark:bg-zinc-800/30">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          {t("device.hue.channelMap.title")}
        </p>
        <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">{t("device.hue.channelMap.loading")}</p>
      </div>
    );
  }

  if (channels.length === 0) {
    return null;
  }

  const hasSelection = selectedDot !== null;

  return (
    <div className="mt-4 rounded-xl border border-slate-200/80 bg-slate-50/60 dark:border-zinc-700/60 dark:bg-zinc-800/30">
      {/* Header */}
      <div className="border-b border-slate-100 px-4 py-3 dark:border-zinc-700/50">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          {t("device.hue.channelMap.title")}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">
          {hasSelection
            ? t("device.hue.channelMap.selectZoneHint")
            : t("device.hue.channelMap.hint")}
        </p>
      </div>

      <div className="px-4 pb-4 pt-3">
        {/* ── Spatial Room View ── */}
        <div className="relative w-full overflow-hidden rounded-xl border border-slate-200/40 dark:border-zinc-700/40"
          style={{ aspectRatio: "16 / 10" }}
        >
          {/* Room background — dark gradient with subtle depth */}
          <div className="absolute inset-0 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black">
            {/* Ambient room glow — radial from center */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(100,116,139,0.04)_0%,transparent_60%)]" />
          </div>

          {/* Wall glow zones — subtle colored gradients on edges */}
          <div className="absolute inset-0 pointer-events-none">
            {/* Top glow */}
            <div className="absolute left-[15%] right-[15%] top-0 h-[25%] bg-gradient-to-b from-emerald-500/[0.06] to-transparent" />
            {/* Bottom glow */}
            <div className="absolute bottom-0 left-[15%] right-[15%] h-[25%] bg-gradient-to-t from-amber-500/[0.06] to-transparent" />
            {/* Left glow */}
            <div className="absolute bottom-[15%] left-0 top-[15%] w-[25%] bg-gradient-to-r from-blue-500/[0.06] to-transparent" />
            {/* Right glow */}
            <div className="absolute bottom-[15%] right-0 top-[15%] w-[25%] bg-gradient-to-l from-violet-500/[0.06] to-transparent" />
          </div>

          {/* TV Screen — centered glowing rectangle */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ width: "52%", height: "56%", perspective: "600px" }}
          >
            <div
              className="relative h-full w-full rounded-md border-2 border-zinc-600/60 bg-zinc-950"
              style={{ transform: "rotateX(3deg)" }}
            >
              {/* Screen inner glow */}
              <div className="absolute inset-0 rounded-sm bg-[radial-gradient(ellipse_at_center,rgba(148,163,184,0.05)_0%,transparent_70%)]" />
              {/* Screen reflection line */}
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-zinc-500/20 to-transparent" />
              {/* Screen label */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-700 select-none">
                  {t("device.hue.channelMap.screenLabel")}
                </span>
              </div>
            </div>
            {/* TV stand */}
            <div className="mx-auto mt-px h-1 w-10 rounded-b-sm bg-zinc-700/40" />
          </div>

          {/* Zone overlay — clickable regions, visible when a channel is selected */}
          {hasSelection && (
            <div className="absolute inset-0 z-10">
              {REGIONS.map((region) => {
                const insets = ZONE_INSETS[region];
                const colors = REGION_COLOR[region];
                const selectedCh = channels.find((c) => c.index === selectedDot);
                const effectiveRegion = selectedCh
                  ? (overrides[selectedCh.index] ?? selectedCh.autoRegion) as Region
                  : null;
                const isCurrentZone = effectiveRegion === region;

                return (
                  <button
                    key={region}
                    type="button"
                    onClick={() => handleZoneClick(region)}
                    className={`absolute flex items-center justify-center rounded-lg border transition-all duration-150 ${
                      isCurrentZone
                        ? `${colors.bg} border-current/30 ${colors.text} ring-1 ring-current/20`
                        : `${colors.bg} border-transparent opacity-60 hover:opacity-100`
                    }`}
                    style={{
                      top: insets.top,
                      right: insets.right,
                      bottom: insets.bottom,
                      left: insets.left,
                    }}
                    aria-label={t("device.hue.channelMap.zonePicker") + ": " + regionLabel(region)}
                  >
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${colors.text} ${isCurrentZone ? "opacity-100" : "opacity-70"}`}>
                      {regionLabel(region)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Channel dots */}
          {channels.map((ch) => {
            const { left, top } = posToPercent(ch.positionX, ch.positionY);
            const dist = distFromCenter(ch.positionX, ch.positionY);
            const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
            const colors = REGION_COLOR[effectiveRegion] ?? REGION_COLOR.center;
            const isSelected = selectedDot === ch.index;
            const isOverridden = Boolean(overrides[ch.index]);
            // Dots farther from center appear slightly larger (closer to viewer)
            const scale = 1 + dist * 0.25;
            // Clamp position so dots don't clip at edges
            const clampedLeft = Math.max(6, Math.min(94, left));
            const clampedTop = Math.max(6, Math.min(94, top));

            return (
              <button
                key={ch.index}
                type="button"
                onClick={() => setSelectedDot(isSelected ? null : ch.index)}
                className="absolute z-20 -translate-x-1/2 -translate-y-1/2 transition-all duration-150"
                style={{ left: `${clampedLeft}%`, top: `${clampedTop}%` }}
                aria-label={t("device.hue.channelMap.selectedChannel", { index: ch.index + 1 })}
              >
                <div
                  className={`flex items-center justify-center rounded-full text-[8px] font-bold text-white transition-all duration-150 ${colors.dot} ${
                    isSelected
                      ? `h-8 w-8 ${colors.glow} ring-2 ring-white/70`
                      : `h-5 w-5 ${isOverridden ? "ring-1 ring-white/30" : ""}`
                  }`}
                  style={isSelected ? undefined : { transform: `scale(${scale})` }}
                >
                  {ch.index + 1}
                </div>
                {/* Pulse ring for selected dot */}
                {isSelected && (
                  <div className={`absolute inset-0 -m-1 animate-ping rounded-full ${colors.dot} opacity-20`} />
                )}
              </button>
            );
          })}
        </div>

        {/* Region legend */}
        <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
          {REGIONS.map((region) => (
            <div key={region} className="flex items-center gap-1">
              <div className={`h-2 w-2 rounded-full ${REGION_COLOR[region].dot}`} />
              <span className="text-[10px] text-slate-400 dark:text-zinc-500">{regionLabel(region)}</span>
            </div>
          ))}
        </div>

        {/* ── Compact channel chip list ── */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {channels.map((ch) => {
            const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
            const isOverridden = Boolean(overrides[ch.index]);
            const isSaved = savedChannelIndex === ch.index;
            const isSelected = selectedDot === ch.index;
            const colors = REGION_COLOR[effectiveRegion] ?? REGION_COLOR.center;

            return (
              <button
                key={ch.index}
                type="button"
                onClick={() => setSelectedDot(isSelected ? null : ch.index)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-1 ${
                  isSelected
                    ? "border-slate-300 bg-slate-100 dark:border-zinc-600 dark:bg-zinc-800/80"
                    : "border-slate-100 bg-white hover:border-slate-200 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
                }`}
              >
                {/* Colored dot */}
                <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${colors.dot}`} />

                {/* Channel number */}
                <span className="font-semibold text-slate-700 dark:text-zinc-200">
                  {t("device.hue.channelMap.chipLabel", { index: ch.index + 1 })}
                </span>

                {/* Region label */}
                <span className={`font-medium ${colors.text}`}>
                  {regionLabel(effectiveRegion)}
                </span>

                {/* Saved flash or override indicator */}
                {isSaved ? (
                  <span className="text-[9px] font-medium text-emerald-500">
                    {t("device.hue.channelMap.saved")}
                  </span>
                ) : isOverridden ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSetRegion(ch.index, null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        e.preventDefault();
                        handleSetRegion(ch.index, null);
                      }
                    }}
                    className="cursor-pointer text-[9px] text-slate-400 underline decoration-dotted hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                    title={t("device.hue.channelMap.resetToAuto")}
                  >
                    {t("device.hue.channelMap.auto")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Mini spatial preview for area cards ── */

/** Approximate channel positions distributed around a rectangle perimeter.
 *  Used when actual position data is not yet loaded. */
function generateApproxPositions(count: number): { positionX: number; positionY: number }[] {
  if (count <= 0) return [];
  const positions: { positionX: number; positionY: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    if (t < 0.25) {
      const frac = t / 0.25;
      positions.push({ positionX: -0.8 + frac * 1.6, positionY: 0.8 });
    } else if (t < 0.5) {
      const frac = (t - 0.25) / 0.25;
      positions.push({ positionX: 0.8, positionY: 0.8 - frac * 1.6 });
    } else if (t < 0.75) {
      const frac = (t - 0.5) / 0.25;
      positions.push({ positionX: 0.8 - frac * 1.6, positionY: -0.8 });
    } else {
      const frac = (t - 0.75) / 0.25;
      positions.push({ positionX: -0.8, positionY: -0.8 + frac * 1.6 });
    }
  }
  return positions;
}

interface MiniSpatialPreviewProps {
  channels?: { positionX: number; positionY: number }[];
  channelCount?: number;
}

/** Tiny (48x32) dot-map preview of channel positions for area cards. */
export function MiniSpatialPreview({ channels, channelCount }: MiniSpatialPreviewProps) {
  const resolvedChannels = useMemo(() => {
    if (channels && channels.length > 0) return channels;
    if (channelCount && channelCount > 0) return generateApproxPositions(channelCount);
    return [];
  }, [channels, channelCount]);

  if (resolvedChannels.length === 0) return null;

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded border border-slate-200/60 bg-zinc-950 dark:border-zinc-700/50"
      style={{ width: 48, height: 32 }}
    >
      {resolvedChannels.map((ch, i) => {
        const left = ((ch.positionX + 1) / 2) * 100;
        const top = ((1 - ch.positionY) / 2) * 100;
        return (
          <div
            key={i}
            className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400 dark:bg-zinc-400"
            style={{ left: `${Math.max(10, Math.min(90, left))}%`, top: `${Math.max(10, Math.min(90, top))}%` }}
          />
        );
      })}
    </div>
  );
}
