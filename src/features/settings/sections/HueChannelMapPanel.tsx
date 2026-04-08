import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import type { HueAreaChannelInfo } from "../../device/hueOnboardingApi";
import type { HueChannelPlacement } from "../../../shared/contracts/roomMap";
import { HUE_COMMANDS, HUE_RUNTIME_STATUS } from "../../../shared/contracts/hue";

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
  /** When true, renders inline amber error message below the detail strip. */
  persistError?: boolean;
  /** Bridge IP for write-back (CHAN-05). */
  bridgeIp?: string;
  /** Hue application key (username) for write-back (CHAN-05). */
  username?: string;
  /** Entertainment area ID for write-back (CHAN-05). */
  areaId?: string;
  /** When true, the save-to-bridge button is disabled with tooltip. */
  isStreaming?: boolean;
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

/**
 * Pre-compute the maximum allowed delta so that NO channel in the selected group
 * exceeds [-1.0, 1.0] on either axis. Relative positions within the group are preserved.
 * (RESEARCH Pattern 3, D-03b)
 */
function clampGroupDelta(
  allPlacements: HueChannelPlacement[],
  selectedIndices: Set<number>,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  let clampedDx = dx;
  let clampedDy = dy;
  for (const p of allPlacements) {
    if (!selectedIndices.has(p.channelIndex)) continue;
    const newX = p.x + dx;
    const newY = p.y + dy;
    if (newX > 1) clampedDx = Math.min(clampedDx, 1 - p.x);
    if (newX < -1) clampedDx = Math.max(clampedDx, -1 - p.x);
    if (newY > 1) clampedDy = Math.min(clampedDy, 1 - p.y);
    if (newY < -1) clampedDy = Math.max(clampedDy, -1 - p.y);
  }
  return { dx: clampedDx, dy: clampedDy };
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
// ChannelDetailStrip sub-component (D-02a, D-02b)
// ---------------------------------------------------------------------------

function ChannelDetailStrip({
  selectedChannels,
  channelPlacements,
  channels,
  onZChange,
  t,
}: {
  selectedChannels: Set<number>;
  channelPlacements: HueChannelPlacement[];
  channels: HueAreaChannelInfo[];
  onZChange: (z: number) => void;
  t: (key: string) => string;
}) {
  if (selectedChannels.size === 0) {
    return (
      <div
        role="region"
        aria-label="Channel detail"
        aria-hidden="true"
        className="overflow-hidden transition-all duration-150 opacity-0 max-h-0"
      />
    );
  }

  // Show last selected channel's values
  const selectedArr = [...selectedChannels];
  const lastSelected = selectedArr[selectedArr.length - 1]!;
  const placement = channelPlacements.find((p) => p.channelIndex === lastSelected);
  const chInfo = channels.find((c) => c.index === lastSelected);
  const channelLabel = chInfo ? `Ch ${chInfo.index + 1}` : `Ch ${lastSelected + 1}`;

  return (
    <div
      role="region"
      aria-label="Channel detail"
      className="mt-2 flex items-center gap-4 rounded-lg border border-slate-200/40 bg-slate-50/40 px-4 py-2 transition-all duration-150 dark:border-zinc-700/40 dark:bg-zinc-800/20"
    >
      {/* Channel name */}
      <span className="text-[11px] font-semibold text-slate-700 dark:text-zinc-200 shrink-0">
        {channelLabel}
      </span>

      {/* Read-only x/y */}
      <span className="text-[10px] text-slate-400 dark:text-zinc-500 shrink-0">
        {t("device.hue.channelMap.detailStripPosition")}: x: {placement?.x.toFixed(2) ?? "0.00"}  y: {placement?.y.toFixed(2) ?? "0.00"}
      </span>

      {/* Z-axis slider */}
      <label className="flex items-center gap-2 ml-auto shrink-0">
        <span className="text-[10px] text-slate-400 dark:text-zinc-500">
          {t("device.hue.channelMap.detailStripHeight")}
        </span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={placement?.z ?? 0}
          onChange={(e) => { onZChange(parseFloat(e.target.value)); }}
          className="w-24 accent-slate-500 dark:accent-zinc-400"
          aria-label={`Height (z) for channel ${lastSelected + 1}`}
          aria-valuemin={-1}
          aria-valuemax={1}
          aria-valuenow={placement?.z ?? 0}
        />
        <span className="w-10 text-right text-[10px] font-semibold tabular-nums text-slate-700 dark:text-zinc-200">
          {(placement?.z ?? 0).toFixed(2)}
        </span>
      </label>
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
  groupStartPositions: Map<number, { x: number; y: number }>;
}

export function HueChannelMapPanel({
  channels,
  isLoading,
  overrides,
  onSetRegion,
  placements,
  onPositionChange,
  persistError,
  bridgeIp,
  username,
  areaId,
  isStreaming = false,
}: Props) {
  const { t } = useTranslation();

  // Stable ref for placements so useEffect doesn't cycle on new array references
  const placementsRef = useRef<HueChannelPlacement[]>(placements ?? []);
  placementsRef.current = placements ?? [];

  // Mode toggle — default "assign-zone" for backward compat (D-01a)
  const [mode, setMode] = useState<EditorMode>("assign-zone");

  // Multi-select (Plan 02: Shift+click multi-select, D-03a)
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());

  // Backward-compat alias for zone assignment
  const selectedDot = selectedChannels.size === 1 ? [...selectedChannels][0]! : null;
  const hasSelection = selectedChannels.size > 0;

  // Drag state — includes groupStartPositions for group drag (D-03b)
  const dragStateRef = useRef<DragState>({
    active: false,
    channelIndex: null,
    startHueX: 0,
    startHueY: 0,
    groupStartPositions: new Map(),
  });
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);

  // Saved flash state (zone assignment)
  const [savedChannelIndex, setSavedChannelIndex] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CHAN-05: write-back state
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; code?: string; message?: string } | null>(null);
  const saveResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  // CHAN-05: Save to bridge handler
  // -------------------------------------------------------------------------

  const handleSaveToBridge = useCallback(async () => {
    if (!bridgeIp || !username || !areaId) return;
    const confirmed = window.confirm(t("device.hue.channelMap.saveConfirm", { ip: bridgeIp }));
    if (!confirmed) return;

    setIsSaving(true);
    setSaveResult(null);
    if (saveResultTimerRef.current !== null) {
      clearTimeout(saveResultTimerRef.current);
      saveResultTimerRef.current = null;
    }

    try {
      const response = await invoke<{ code: string; message: string }>(
        HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS,
        { channels: channelPlacements, bridgeIp, username, areaId },
      );
      if (response.code === HUE_RUNTIME_STATUS.CHANNEL_POSITIONS_UPDATED) {
        setSaveResult({ ok: true });
        saveResultTimerRef.current = setTimeout(() => {
          setSaveResult(null);
          saveResultTimerRef.current = null;
        }, 3000);
      } else {
        setSaveResult({ ok: false, code: response.code, message: response.message });
      }
    } catch (err) {
      setSaveResult({ ok: false, code: "CHAN_WB_NETWORK_ERROR", message: String(err) });
    } finally {
      setIsSaving(false);
    }
  }, [bridgeIp, username, areaId, channelPlacements, t]);

  // -------------------------------------------------------------------------
  // Z-axis change handler (D-02a, D-02b)
  // -------------------------------------------------------------------------

  const handleZChange = useCallback((z: number) => {
    setChannelPlacements((prev) => {
      const next = prev.map((p) =>
        selectedChannels.has(p.channelIndex) ? { ...p, z } : p
      );
      // Persist immediately for z changes
      onPositionChange?.(next);
      return next;
    });
  }, [selectedChannels, onPositionChange]);

  // -------------------------------------------------------------------------
  // Pointer event handlers (drag with group support, D-03b)
  // -------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, channelIndex: number) => {
      if (mode !== "position") return;
      e.currentTarget.setPointerCapture(e.pointerId);

      // If clicking a non-selected channel, select it alone first
      const isAlreadySelected = selectedChannels.has(channelIndex);
      const effectiveSelected = isAlreadySelected ? selectedChannels : new Set([channelIndex]);

      if (!isAlreadySelected) {
        setSelectedChannels(new Set([channelIndex]));
      }

      const groupStart = new Map<number, { x: number; y: number }>();
      for (const idx of effectiveSelected) {
        const p = channelPlacements.find((cp) => cp.channelIndex === idx);
        if (p) groupStart.set(idx, { x: p.x, y: p.y });
      }

      const placement = channelPlacements.find((p) => p.channelIndex === channelIndex);
      if (!placement) return;

      dragStateRef.current = {
        active: true,
        channelIndex,
        startHueX: placement.x,
        startHueY: placement.y,
        groupStartPositions: groupStart,
      };
      setDragPosition({ x: placement.x, y: placement.y });
    },
    [mode, channelPlacements, selectedChannels],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const ds = dragStateRef.current;
    if (!ds.active || !canvasRef.current || ds.channelIndex === null) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const coords = clientToHueCoords(e.clientX, e.clientY, rect);

    // Raw delta from drag start position
    const rawDx = coords.x - ds.startHueX;
    const rawDy = coords.y - ds.startHueY;

    // Build "virtual" placements at group start positions for clamping
    const startPlacements: HueChannelPlacement[] = [];
    for (const [idx, pos] of ds.groupStartPositions) {
      startPlacements.push({ channelIndex: idx, x: pos.x, y: pos.y, z: 0 });
    }

    const { dx, dy } = clampGroupDelta(startPlacements, new Set(ds.groupStartPositions.keys()), rawDx, rawDy);

    // Update tooltip position for the dragged channel
    const dragStart = ds.groupStartPositions.get(ds.channelIndex);
    if (dragStart) {
      setDragPosition({ x: dragStart.x + dx, y: dragStart.y + dy });
    }

    // Apply clamped delta to ALL selected channels from their start positions
    setChannelPlacements((prev) =>
      prev.map((p) => {
        const start = ds.groupStartPositions.get(p.channelIndex);
        if (!start) return p;
        return { ...p, x: start.x + dx, y: start.y + dy };
      })
    );
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragStateRef.current.active) return;
    dragStateRef.current = {
      active: false,
      channelIndex: null,
      startHueX: 0,
      startHueY: 0,
      groupStartPositions: new Map(),
    };
    setDragPosition(null);
    // Functional update pattern — avoids stale closure over channelPlacements
    setChannelPlacements((current) => {
      onPositionChange?.(current);
      return current;
    });
  }, [onPositionChange]);

  // -------------------------------------------------------------------------
  // Keyboard arrow key support (group movement with clampGroupDelta)
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, channelIndex: number) => {
      if (mode !== "position" || !selectedChannels.has(channelIndex)) return;
      const delta = 0.05;
      let rawDx = 0;
      let rawDy = 0;
      if (e.key === "ArrowLeft") rawDx = -delta;
      else if (e.key === "ArrowRight") rawDx = delta;
      else if (e.key === "ArrowUp") rawDy = delta; // up = positive y in Hue coords
      else if (e.key === "ArrowDown") rawDy = -delta;
      else return;
      e.preventDefault();

      // Use clampGroupDelta for group boundary check
      const selectedPlacements = channelPlacements.filter((p) => selectedChannels.has(p.channelIndex));
      const { dx, dy } = clampGroupDelta(selectedPlacements, selectedChannels, rawDx, rawDy);

      setChannelPlacements((prev) => {
        const next = prev.map((p) =>
          selectedChannels.has(p.channelIndex)
            ? { ...p, x: Math.max(-1, Math.min(1, p.x + dx)), y: Math.max(-1, Math.min(1, p.y + dy)) }
            : p
        );
        onPositionChange?.(next);
        return next;
      });
    },
    [mode, selectedChannels, channelPlacements, onPositionChange],
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
      <div className="mt-0.5 flex items-center">
        <p className="text-[11px] text-slate-500 dark:text-zinc-400">
          {hintText}
        </p>
        {/* Multi-select count badge (D-03a) */}
        {mode === "position" && selectedChannels.size > 1 && (
          <span className="ml-2 inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
            {t("device.hue.channelMap.multiSelectCount", { count: String(selectedChannels.size) })}
          </span>
        )}
      </div>

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
          const isSingleSelected = isSelected && selectedChannels.size === 1;
          const isMultiSelected = isSelected && selectedChannels.size > 1;
          const isDragging = dragStateRef.current.active && dragStateRef.current.channelIndex === ch.index;

          return (
            <div
              key={ch.index}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <div className="relative">
                {/* Pulse animation — only for single-selected (D-03a visual) */}
                {isSingleSelected && (
                  <div className={`absolute inset-0 -m-1 animate-ping rounded-full ${colorClass} opacity-20`} />
                )}
                <button
                  type="button"
                  aria-pressed={isSelected}
                  className={[
                    "flex items-center justify-center rounded-full text-[9px] font-bold text-white shadow-sm",
                    // Size: selected channels appear larger
                    isSingleSelected ? "h-8 w-8" : isMultiSelected ? "h-8 w-8" : "h-5 w-5",
                    colorClass,
                    isOverridden ? "ring-2 ring-white ring-offset-1 dark:ring-zinc-900" : "",
                    // Multi-select visual: ring-2 ring-white/50, no glow
                    isMultiSelected ? "ring-2 ring-white/50" : "",
                    // Single-select visual: ring-2 ring-white/70 with glow
                    isSingleSelected ? "ring-2 ring-white/70" : "",
                    mode === "position" ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1",
                  ].join(" ")}
                  onClick={(e) => {
                    if (mode === "position") {
                      setSelectedChannels((prev) => {
                        if (e.shiftKey) {
                          // Shift+click: add or remove from selection
                          const next = new Set(prev);
                          if (next.has(ch.index)) { next.delete(ch.index); } else { next.add(ch.index); }
                          return next;
                        }
                        // Normal click: toggle single selection
                        if (prev.has(ch.index) && prev.size === 1) return new Set();
                        return new Set([ch.index]);
                      });
                    } else {
                      // assign-zone mode: single select only (existing behavior)
                      setSelectedChannels((prev) =>
                        prev.has(ch.index) && prev.size === 1 ? new Set() : new Set([ch.index])
                      );
                    }
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
            </div>
          );
        })}

        {/* Zone overlay (assign-zone mode only, D-01a) */}
        {hasSelection && mode === "assign-zone" && selectedDot !== null && (
          <div className="absolute inset-0 bg-black/20" />
        )}
      </div>

      {/* Z-axis detail strip (D-02a) */}
      <ChannelDetailStrip
        selectedChannels={selectedChannels}
        channelPlacements={channelPlacements}
        channels={channels}
        onZChange={handleZChange}
        t={t}
      />

      {/* Persist error feedback */}
      {persistError && (
        <p className="mt-1 px-4 text-[10px] text-amber-500">
          {t("device.hue.channelMap.saveError")}
        </p>
      )}

      {/* CHAN-05: Save to Bridge button with Beta badge */}
      {bridgeIp && username && areaId ? (
        <>
          <div className="mt-3 flex items-center justify-end gap-2 px-4">
            <span className="rounded px-2 py-1 text-[9px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
              {t("device.hue.channelMap.beta")}
            </span>
            <button
              type="button"
              disabled={isStreaming || isSaving}
              title={isStreaming ? t("device.hue.channelMap.saveToBridgeTooltip") : undefined}
              onClick={() => { void handleSaveToBridge(); }}
              className={`rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-800
                hover:border-slate-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500
                transition-colors duration-150
                ${(isStreaming || isSaving) ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {isSaving ? t("device.hue.channelMap.saving") : t("device.hue.channelMap.saveToBridge")}
            </button>
          </div>
          {saveResult !== null && (
            <div className={`mt-1 px-4 text-[10px] ${saveResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
              {saveResult.ok
                ? t("device.hue.channelMap.savedToBridge")
                : (
                  <>
                    {t("device.hue.channelMap.saveToBridgeError", { code: saveResult.code ?? "" })}
                    {" "}
                    <button
                      type="button"
                      onClick={() => { void handleSaveToBridge(); }}
                      className="text-xs underline hover:opacity-80"
                    >
                      {t("device.hue.channelMap.saveToBridgeErrorRetry")}
                    </button>
                  </>
                )
              }
            </div>
          )}
        </>
      ) : null}

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
                  onClick={(e) => {
                    if (mode === "position") {
                      setSelectedChannels((prev) => {
                        if (e.shiftKey) {
                          const next = new Set(prev);
                          if (next.has(ch.index)) { next.delete(ch.index); } else { next.add(ch.index); }
                          return next;
                        }
                        if (prev.has(ch.index) && prev.size === 1) return new Set();
                        return new Set([ch.index]);
                      });
                    } else {
                      setSelectedChannels((prev) => {
                        if (prev.has(ch.index) && prev.size === 1) return new Set();
                        return new Set([ch.index]);
                      });
                    }
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

// ---------------------------------------------------------------------------
// MiniSpatialPreview (unchanged from Plan 01)
// ---------------------------------------------------------------------------

/** Minimal channel shape required for MiniSpatialPreview dot rendering. */
interface MiniChannelShape {
  positionX: number;
  positionY: number;
  autoRegion?: string;
  index?: number;
}

export function MiniSpatialPreview({
  channels,
  channelCount,
}: {
  channels?: MiniChannelShape[];
  channelCount?: number;
}) {
  // When channels list is available, render dots at their positions.
  // When only channelCount is provided (legacy usage), render evenly distributed placeholder dots.
  const MINI_REGION_COLORS: Record<Region, string> = {
    left: "bg-blue-400",
    right: "bg-purple-400",
    top: "bg-emerald-400",
    bottom: "bg-amber-400",
    center: "bg-slate-400",
  };

  const placeholderCount = channelCount ?? 0;

  return (
    <div className="relative h-12 w-full overflow-hidden rounded-md border border-slate-200 bg-white dark:border-zinc-600 dark:bg-zinc-900">
      {/* Axis lines */}
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-slate-100 dark:bg-zinc-700" />
      <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-slate-100 dark:bg-zinc-700" />
      {channels
        ? channels.map((ch, i) => {
            const { left, top } = posToPercent(ch.positionX, ch.positionY);
            const colorClass = MINI_REGION_COLORS[(ch.autoRegion as Region)] ?? "bg-slate-400";
            return (
              <div
                key={ch.index ?? i}
                className={`absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${colorClass}`}
                style={{ left, top }}
                aria-hidden="true"
              />
            );
          })
        : Array.from({ length: placeholderCount }, (_, i) => {
            const x = placeholderCount > 1 ? (i / (placeholderCount - 1)) * 2 - 1 : 0;
            const { left, top } = posToPercent(x, 0);
            return (
              <div
                key={i}
                className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400"
                style={{ left, top }}
                aria-hidden="true"
              />
            );
          })}
    </div>
  );
}
