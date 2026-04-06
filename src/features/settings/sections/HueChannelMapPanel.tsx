import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueAreaChannelInfo } from "../../device/hueOnboardingApi";
import type { HueChannelPlacement } from "../../../shared/contracts/roomMap";

const REGIONS = ["left", "right", "top", "bottom", "center"] as const;
type Region = (typeof REGIONS)[number];

/** Editor mode — controls whether drag or zone assignment is active */
type EditorMode = "position" | "assign-zone";

interface Props {
  channels: HueAreaChannelInfo[];
  isLoading: boolean;
  overrides: Record<number, string>;
  onSetRegion: (channelIndex: number, region: string | null) => void;
  /** Persisted channel placements from shellStore. Falls back to bridge positionX/Y when absent. */
  placements?: HueChannelPlacement[];
  /** Called when any channel position changes (after pointer-up or arrow key). */
  onPositionChange?: (updated: HueChannelPlacement[]) => void;
}

/** Convert Hue position (x: -1..+1, y: -1..+1) to CSS % inside the grid box.
 *  Hue x: -1=left, +1=right → left%
 *  Hue y: -1=bottom, +1=top → we flip so top of box = top of screen
 */
function posToPercent(x: number, y: number): { left: string; top: string } {
  const left = `${((x + 1) / 2) * 100}%`;
  const top = `${((1 - y) / 2) * 100}%`; // flip Y axis
  return { left, top };
}

/** Inverse of posToPercent: convert client pixel position to Hue [-1,1] coords.
 *  Critical: y-flip must be exact inverse — hueY = 1 - relY * 2 */
function clientToHueCoords(clientX: number, clientY: number, canvasRect: DOMRect): { x: number; y: number } {
  const relX = (clientX - canvasRect.left) / canvasRect.width;
  const relY = (clientY - canvasRect.top) / canvasRect.height;
  const hueX = relX * 2 - 1;
  const hueY = 1 - relY * 2;
  return {
    x: Math.max(-1, Math.min(1, hueX)),
    y: Math.max(-1, Math.min(1, hueY)),
  };
}

/** Merge bridge-reported position with persisted placement. Fallback to bridge data + z=0. */
function resolvePlacement(ch: HueAreaChannelInfo, placements: HueChannelPlacement[]): { x: number; y: number; z: number } {
  const saved = placements.find((p) => p.channelIndex === ch.index);
  return saved
    ? { x: saved.x, y: saved.y, z: saved.z }
    : { x: ch.positionX, y: ch.positionY, z: 0 };
}

const REGION_COLORS: Record<Region, string> = {
  left: "bg-blue-500",
  right: "bg-purple-500",
  top: "bg-emerald-500",
  bottom: "bg-amber-500",
  center: "bg-slate-500",
};

const REGION_COLORS_ACTIVE: Record<Region, string> = {
  left: "bg-blue-600 text-white",
  right: "bg-purple-600 text-white",
  top: "bg-emerald-600 text-white",
  bottom: "bg-amber-600 text-white",
  center: "bg-slate-600 text-white",
};

const SAVED_FLASH_MS = 2000;

// ---------------------------------------------------------------------------
// ModePillToggle sub-component
// ---------------------------------------------------------------------------

function ModePillToggle({
  mode,
  onModeChange,
  t,
}: {
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex rounded-lg bg-slate-50 p-0.5 dark:bg-zinc-900/60">
      <button
        type="button"
        onClick={() => { onModeChange("position"); }}
        aria-pressed={mode === "position"}
        className={`rounded-md px-2.5 py-1 text-[10px] transition-colors ${
          mode === "position"
            ? "bg-slate-100 font-semibold text-slate-700 dark:bg-zinc-800 dark:text-zinc-200"
            : "font-normal text-slate-400 hover:text-slate-600 dark:text-zinc-500"
        }`}
      >
        {t("device.hue.channelMap.modPosition")}
      </button>
      <button
        type="button"
        onClick={() => { onModeChange("assign-zone"); }}
        aria-pressed={mode === "assign-zone"}
        className={`rounded-md px-2.5 py-1 text-[10px] transition-colors ${
          mode === "assign-zone"
            ? "bg-slate-100 font-semibold text-slate-700 dark:bg-zinc-800 dark:text-zinc-200"
            : "font-normal text-slate-400 hover:text-slate-600 dark:text-zinc-500"
        }`}
      >
        {t("device.hue.channelMap.modAssignZone")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DragCoordinateTooltip sub-component
// ---------------------------------------------------------------------------

function DragCoordinateTooltip({
  x,
  y,
  t,
}: {
  x: number;
  y: number;
  t: (key: string, opts?: Record<string, string>) => string;
}) {
  return (
    <div
      className="pointer-events-none absolute z-30 rounded-md bg-zinc-900/90 px-2 py-1 text-[10px] font-semibold text-zinc-100"
      style={{ transform: "translate(12px, -28px)" }}
      aria-label={t("device.hue.channelMap.tooltipAriaLabel", { x: x.toFixed(2), y: y.toFixed(2) })}
    >
      x: {x.toFixed(2)}, y: {y.toFixed(2)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HueChannelMapPanel main component
// ---------------------------------------------------------------------------

/** Intermediate drag state tracked via ref — avoids re-renders on each pointer move */
interface DragState {
  active: boolean;
  channelIndex: number | null;
  startHueX: number;
  startHueY: number;
}

export function HueChannelMapPanel({
  channels,
  isLoading,
  overrides,
  onSetRegion,
  placements,
  onPositionChange,
}: Props) {
  const { t } = useTranslation();

  // Stable ref for placements so useEffect doesn't cycle on new array references
  const placementsRef = useRef<HueChannelPlacement[]>(placements ?? []);
  placementsRef.current = placements ?? [];

  // Mode toggle — default "assign-zone" for backward compat (D-01a)
  const [mode, setMode] = useState<EditorMode>("assign-zone");

  // Multi-select (Plan 01: single-select only; Plan 02: Shift+click)
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());

  // Backward-compat alias for zone assignment
  const selectedDot = selectedChannels.size === 1 ? [...selectedChannels][0]! : null;
  const hasSelection = selectedChannels.size > 0;

  // Drag state
  const dragStateRef = useRef<DragState>({ active: false, channelIndex: null, startHueX: 0, startHueY: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);

  // Saved flash state (zone assignment)
  const [savedChannelIndex, setSavedChannelIndex] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local channel placements — initialized from bridge data + persisted overrides
  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>(() =>
    channels.map((ch) => {
      const p = resolvePlacement(ch, placementsRef.current);
      return { channelIndex: ch.index, x: p.x, y: p.y, z: p.z };
    }),
  );

  // Re-initialize when channels change (area switch). placementsRef read via ref to avoid cycle.
  useEffect(() => {
    setChannelPlacements(
      channels.map((ch) => {
        const p = resolvePlacement(ch, placementsRef.current);
        return { channelIndex: ch.index, x: p.x, y: p.y, z: p.z };
      }),
    );
  }, [channels]);

  const regionLabel = (region: string): string => {
    const key = `device.hue.channelMap.regions.${region}`;
    const translated = t(key);
    return translated === key ? region : translated;
  };

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

  // -------------------------------------------------------------------------
  // Pointer event handlers (drag)
  // -------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, channelIndex: number) => {
      if (mode !== "position") return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const placement = channelPlacements.find((p) => p.channelIndex === channelIndex);
      if (!placement) return;
      dragStateRef.current = {
        active: true,
        channelIndex,
        startHueX: placement.x,
        startHueY: placement.y,
      };
      setDragPosition({ x: placement.x, y: placement.y });
    },
    [mode, channelPlacements],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStateRef.current.active || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const coords = clientToHueCoords(e.clientX, e.clientY, rect);
    setDragPosition(coords);
    const idx = dragStateRef.current.channelIndex;
    if (idx === null) return;
    setChannelPlacements((prev) =>
      prev.map((p) => (p.channelIndex === idx ? { ...p, x: coords.x, y: coords.y } : p)),
    );
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragStateRef.current.active) return;
    dragStateRef.current = { active: false, channelIndex: null, startHueX: 0, startHueY: 0 };
    setDragPosition(null);
    // Functional update pattern — avoids stale closure over channelPlacements
    setChannelPlacements((current) => {
      onPositionChange?.(current);
      return current;
    });
  }, [onPositionChange]);

  // -------------------------------------------------------------------------
  // Keyboard arrow key support (position mode, selected channel)
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, channelIndex: number) => {
      if (mode !== "position" || !selectedChannels.has(channelIndex)) return;
      const delta = 0.05;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -delta;
      else if (e.key === "ArrowRight") dx = delta;
      else if (e.key === "ArrowUp") dy = delta; // up = positive y in Hue coords
      else if (e.key === "ArrowDown") dy = -delta;
      else return;
      e.preventDefault();
      setChannelPlacements((prev) => {
        const next = prev.map((p) =>
          p.channelIndex === channelIndex
            ? { ...p, x: Math.max(-1, Math.min(1, p.x + dx)), y: Math.max(-1, Math.min(1, p.y + dy)) }
            : p,
        );
        onPositionChange?.(next);
        return next;
      });
    },
    [mode, selectedChannels, onPositionChange],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          {t("device.hue.channelMap.title")}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">{t("device.hue.channelMap.loading")}</p>
      </div>
    );
  }

  if (channels.length === 0) {
    return null;
  }

  // Hint text varies by mode and selection
  const hintText =
    mode === "assign-zone"
      ? hasSelection
        ? t("device.hue.channelMap.hint")
        : t("device.hue.channelMap.hint")
      : hasSelection
        ? t("device.hue.channelMap.hintPositionModeSelected")
        : t("device.hue.channelMap.hintPositionMode");

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
      {/* Header: title + mode toggle */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          {t("device.hue.channelMap.title")}
        </p>
        <ModePillToggle mode={mode} onModeChange={setMode} t={t} />
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
        {hintText}
      </p>

      {/* Position grid / spatial canvas */}
      <div
        ref={canvasRef}
        className="relative mt-2 h-28 overflow-hidden rounded-md border border-slate-200 bg-white dark:border-zinc-600 dark:bg-zinc-900"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Axis lines */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-slate-100 dark:bg-zinc-700" />
        <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-slate-100 dark:bg-zinc-700" />

        {/* Region labels */}
        <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">L</span>
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">R</span>
        <span className="absolute left-1/2 top-0.5 -translate-x-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">T</span>
        <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">B</span>

        {/* Channel dots */}
        {channels.map((ch) => {
          const placement = channelPlacements.find((p) => p.channelIndex === ch.index);
          const px = placement?.x ?? ch.positionX;
          const py = placement?.y ?? ch.positionY;
          const { left, top } = posToPercent(px, py);
          const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
          const colorClass = REGION_COLORS[effectiveRegion] ?? "bg-slate-500";
          const isOverridden = Boolean(overrides[ch.index]);
          const isSelected = selectedChannels.has(ch.index);
          const isDragging = dragStateRef.current.active && dragStateRef.current.channelIndex === ch.index;

          return (
            <div
              key={ch.index}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <button
                type="button"
                aria-pressed={isSelected}
                className={[
                  "flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white shadow-sm",
                  colorClass,
                  isOverridden ? "ring-2 ring-white ring-offset-1 dark:ring-zinc-900" : "",
                  isSelected ? "ring-2 ring-slate-400 ring-offset-1 dark:ring-slate-500" : "",
                  mode === "position" ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-pointer",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1",
                ].join(" ")}
                onClick={() => {
                  setSelectedChannels((prev) => {
                    if (prev.has(ch.index) && prev.size === 1) return new Set();
                    return new Set([ch.index]);
                  });
                }}
                onPointerDown={(e) => { handlePointerDown(e, ch.index); }}
                onKeyDown={(e) => { handleKeyDown(e, ch.index); }}
              >
                {ch.index + 1}
                {/* Coordinate tooltip during drag */}
                {isDragging && dragPosition && (
                  <DragCoordinateTooltip x={dragPosition.x} y={dragPosition.y} t={t} />
                )}
              </button>
            </div>
          );
        })}

        {/* Zone overlay (assign-zone mode only, D-01a) */}
        {hasSelection && mode === "assign-zone" && selectedDot !== null && (
          <div className="absolute inset-0 bg-black/20" />
        )}
      </div>

      {/* Per-channel region assignment rows */}
      <div className="mt-2 space-y-1.5">
        {channels.map((ch) => {
          const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
          const isOverridden = Boolean(overrides[ch.index]);
          const isSaved = savedChannelIndex === ch.index;

          return (
            <div key={ch.index} className="flex items-center gap-2">
              {/* Channel label */}
              <div className="flex w-16 shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedChannels((prev) => {
                      if (prev.has(ch.index) && prev.size === 1) return new Set();
                      return new Set([ch.index]);
                    });
                  }}
                  className={[
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                    REGION_COLORS[effectiveRegion] ?? "bg-slate-500",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1",
                  ].join(" ")}
                  aria-pressed={selectedChannels.has(ch.index)}
                >
                  {ch.index + 1}
                </button>
                <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                  {ch.lightCount === 1 ? t("device.hue.channelMap.oneLight") : t("device.hue.channelMap.lights", { count: ch.lightCount })}
                </span>
              </div>

              {/* Region pills */}
              <div className="flex flex-wrap gap-1">
                {REGIONS.map((region) => {
                  const isActive = effectiveRegion === region;
                  return (
                    <button
                      key={region}
                      type="button"
                      onClick={() => {
                        if (isActive && isOverridden) {
                          handleSetRegion(ch.index, null);
                        } else if (!isActive || !isOverridden) {
                          handleSetRegion(ch.index, region === ch.autoRegion ? null : region);
                        }
                      }}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
                        isActive
                          ? REGION_COLORS_ACTIVE[region]
                          : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-600"
                      }`}
                    >
                      {regionLabel(region)}
                    </button>
                  );
                })}
              </div>

              {/* Saved flash or override reset */}
              {isSaved ? (
                <span className="ml-auto shrink-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  {t("device.hue.channelMap.saved")}
                </span>
              ) : isOverridden ? (
                <button
                  type="button"
                  onClick={() => {
                    handleSetRegion(ch.index, null);
                  }}
                  className="ml-auto shrink-0 text-[10px] text-slate-400 underline hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  title={t("device.hue.channelMap.resetToAuto")}
                >
                  {t("device.hue.channelMap.auto")}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
