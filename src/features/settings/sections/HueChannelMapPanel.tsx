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

/**
 * Region → token-backed CSS color mapping.
 *
 * Aligned with `--lm-zone-1..4` + `--lm-ink-faint`. Region semantics keep
 * spatial intuition (blue=left, purple=right, emerald=top, amber=bottom,
 * grey=center) but the values now live as CSS variables so the mini
 * preview, the canvas dots and the per-channel rows all draw from the
 * same source of truth.
 */
const REGION_COLOR_VAR: Record<Region, string> = {
  left: "var(--lm-zone-1)",
  right: "var(--lm-zone-3)",
  top: "var(--lm-zone-2)",
  bottom: "var(--lm-amber)",
  center: "var(--lm-ink-faint)",
};

const SAVED_FLASH_MS = 2000;

// ---------------------------------------------------------------------------
// ModePillToggle sub-component — uses `lm-settings-seg` so it matches the
// segmented controls used elsewhere in the settings surface.
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
    <div className="lm-settings-seg" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "position"}
        onClick={() => { onModeChange("position"); }}
        className={mode === "position" ? "is-on" : ""}
      >
        {t("device.hue.channelMap.modPosition")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "assign-zone"}
        onClick={() => { onModeChange("assign-zone"); }}
        className={mode === "assign-zone" ? "is-on" : ""}
      >
        {t("device.hue.channelMap.modAssignZone")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DragCoordinateTooltip — pinned to the dragged channel.
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
      className="lm-chmap-tooltip"
      aria-label={t("device.hue.channelMap.tooltipAriaLabel", { x: x.toFixed(2), y: y.toFixed(2) })}
    >
      x: {x.toFixed(2)}, y: {y.toFixed(2)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelDetailStrip — z-axis slider + read-only x/y for the active channel.
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
  t: (key: string, opts?: Record<string, string>) => string;
}) {
  if (selectedChannels.size === 0) return null;

  // Show last selected channel's values
  const selectedArr = [...selectedChannels];
  const lastSelected = selectedArr[selectedArr.length - 1]!;
  const placement = channelPlacements.find((p) => p.channelIndex === lastSelected);
  const chInfo = channels.find((c) => c.index === lastSelected);
  const channelIndexLabel = String((chInfo?.index ?? lastSelected) + 1);
  const z = placement?.z ?? 0;

  return (
    <div className="lm-chmap-detail" role="region" aria-label={t("device.hue.channelMap.detailStripChannel", { index: channelIndexLabel })}>
      <span className="lm-chmap-detail-name">
        {t("device.hue.channelMap.detailStripChannel", { index: channelIndexLabel })}
      </span>
      <span className="lm-chmap-detail-pos">
        {t("device.hue.channelMap.detailStripCoords", {
          x: (placement?.x ?? 0).toFixed(2),
          y: (placement?.y ?? 0).toFixed(2),
        })}
      </span>

      <label className="lm-chmap-detail-z">
        <span className="lm-chmap-detail-z-label">
          {t("device.hue.channelMap.detailStripHeight")}
        </span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={z}
          onChange={(e) => { onZChange(parseFloat(e.target.value)); }}
          aria-label={t("device.hue.channelMap.detailStripHeight")}
          aria-valuemin={-1}
          aria-valuemax={1}
          aria-valuenow={z}
        />
        <span className="lm-chmap-detail-z-val">{z.toFixed(2)}</span>
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
      console.error("[LumaSync] Hue channel-position write-back failed:", err);
      setSaveResult({ ok: false, code: "CHAN_WB_NETWORK_ERROR", message: String(err) });
    } finally {
      setIsSaving(false);
    }
  }, [bridgeIp, username, areaId, channelPlacements, t]);

  // -------------------------------------------------------------------------
  // Z-axis change handler (D-02a, D-02b)
  // -------------------------------------------------------------------------

  // Latest channelPlacements snapshot for handlers that fire after a drag
  // ends — drag handlers update state via functional updaters, so this ref
  // captures the post-update value without forcing handler rebinds.
  const channelPlacementsRef = useRef(channelPlacements);
  channelPlacementsRef.current = channelPlacements;

  const handleZChange = useCallback((z: number) => {
    const next = channelPlacementsRef.current.map((p) =>
      selectedChannels.has(p.channelIndex) ? { ...p, z } : p
    );
    setChannelPlacements(next);
    onPositionChange?.(next);
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
    // Read latest placements via ref so React 19 strict updaters stay pure
    // (no prop callbacks fired from inside setState updaters).
    onPositionChange?.(channelPlacementsRef.current);
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

      const next = channelPlacementsRef.current.map((p) =>
        selectedChannels.has(p.channelIndex)
          ? { ...p, x: Math.max(-1, Math.min(1, p.x + dx)), y: Math.max(-1, Math.min(1, p.y + dy)) }
          : p
      );
      setChannelPlacements(next);
      onPositionChange?.(next);
    },
    [mode, selectedChannels, channelPlacements, onPositionChange],
  );

  // -------------------------------------------------------------------------
  // Selection toggle helper — shared between canvas dots and per-row dots.
  // -------------------------------------------------------------------------

  const toggleSelection = useCallback(
    (channelIndex: number, shiftKey: boolean) => {
      setSelectedChannels((prev) => {
        if (mode === "position" && shiftKey) {
          const next = new Set(prev);
          if (next.has(channelIndex)) {
            next.delete(channelIndex);
          } else {
            next.add(channelIndex);
          }
          return next;
        }
        if (prev.has(channelIndex) && prev.size === 1) return new Set();
        return new Set([channelIndex]);
      });
    },
    [mode],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (isLoading) {
    return (
      <section className="lm-settings-group lm-chmap" role="region" aria-label={t("device.hue.channelMap.title")}>
        <div className="lm-settings-group-h">
          <span className="t">{t("device.hue.channelMap.title")}</span>
        </div>
        <div className="lm-chmap-body">
          <p className="lm-chmap-hint">{t("device.hue.channelMap.loading")}</p>
        </div>
      </section>
    );
  }

  if (channels.length === 0) {
    return null;
  }

  // Hint text varies by mode and selection
  const hintText =
    mode === "assign-zone"
      ? t("device.hue.channelMap.hint")
      : hasSelection
        ? t("device.hue.channelMap.hintPositionModeSelected")
        : t("device.hue.channelMap.hintPositionMode");

  const hasSaveAction = Boolean(bridgeIp && username && areaId);

  return (
    <section
      className="lm-settings-group lm-chmap"
      role="region"
      aria-label={t("device.hue.channelMap.title")}
    >
      {/* Header — title + mode toggle */}
      <div className="lm-settings-group-h">
        <span className="t">{t("device.hue.channelMap.title")}</span>
        <ModePillToggle mode={mode} onModeChange={setMode} t={t} />
      </div>

      <div className="lm-chmap-body">
        {/* Hint row + multi-select pill */}
        <div className="lm-chmap-hint">
          <span className="lm-chmap-hint-text">{hintText}</span>
          {mode === "position" && selectedChannels.size > 1 && (
            <span className="lm-chmap-multi" aria-live="polite">
              {t("device.hue.channelMap.multiSelectCount", { count: String(selectedChannels.size) })}
            </span>
          )}
        </div>

        {/* Position canvas */}
        <div
          ref={canvasRef}
          className="lm-chmap-canvas"
          role="application"
          aria-label={t("device.hue.channelMap.canvasAriaLabel")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div className="lm-chmap-canvas-axis is-v" aria-hidden />
          <div className="lm-chmap-canvas-axis is-h" aria-hidden />

          {/* Region edge labels — short codes via i18n */}
          <span className="lm-chmap-canvas-edge is-l" aria-hidden>
            {t("device.hue.channelMap.regionShort.left")}
          </span>
          <span className="lm-chmap-canvas-edge is-r" aria-hidden>
            {t("device.hue.channelMap.regionShort.right")}
          </span>
          <span className="lm-chmap-canvas-edge is-t" aria-hidden>
            {t("device.hue.channelMap.regionShort.top")}
          </span>
          <span className="lm-chmap-canvas-edge is-b" aria-hidden>
            {t("device.hue.channelMap.regionShort.bottom")}
          </span>

          {/* Channel dots */}
          {channels.map((ch) => {
            const placement = channelPlacements.find((p) => p.channelIndex === ch.index);
            const px = placement?.x ?? ch.positionX;
            const py = placement?.y ?? ch.positionY;
            const { left, top } = posToPercent(px, py);
            const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
            const dotColor = REGION_COLOR_VAR[effectiveRegion] ?? "var(--lm-ink-faint)";
            const isOverridden = Boolean(overrides[ch.index]);
            const isSelected = selectedChannels.has(ch.index);
            const isSingleSelected = isSelected && selectedChannels.size === 1;
            const isMultiSelected = isSelected && selectedChannels.size > 1;
            const isDragging =
              dragStateRef.current.active && dragStateRef.current.channelIndex === ch.index;

            const classes = [
              "lm-chmap-dot",
              mode === "position" ? "is-position" : "",
              isSingleSelected ? "is-selected" : "",
              isMultiSelected ? "is-multi" : "",
              isOverridden ? "is-overridden" : "",
              isDragging ? "is-dragging" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <button
                key={ch.index}
                type="button"
                className={classes}
                style={{
                  left,
                  top,
                  ["--lm-chmap-dot-color" as string]: dotColor,
                }}
                aria-pressed={isSelected}
                onClick={(e) => {
                  toggleSelection(ch.index, e.shiftKey);
                }}
                onPointerDown={(e) => {
                  handlePointerDown(e, ch.index);
                }}
                onKeyDown={(e) => {
                  handleKeyDown(e, ch.index);
                }}
              >
                {isSingleSelected && <span className="lm-chmap-dot-pulse" aria-hidden />}
                <span>{ch.index + 1}</span>
                {isDragging && dragPosition && (
                  <DragCoordinateTooltip x={dragPosition.x} y={dragPosition.y} t={t} />
                )}
              </button>
            );
          })}

          {/* Assign-zone scrim */}
          {hasSelection && mode === "assign-zone" && selectedDot !== null && (
            <div className="lm-chmap-canvas-scrim" aria-hidden />
          )}
        </div>

        {/* Z-axis detail strip */}
        <ChannelDetailStrip
          selectedChannels={selectedChannels}
          channelPlacements={channelPlacements}
          channels={channels}
          onZChange={handleZChange}
          t={t}
        />

        {/* Persist error feedback (shellStore write failed) */}
        {persistError && (
          <div className="lm-chmap-feedback is-warn" role="alert">
            <span>{t("device.hue.channelMap.saveError")}</span>
          </div>
        )}
      </div>

      {/* Per-channel region assignment rows */}
      <div className="lm-chmap-rows">
        {channels.map((ch) => {
          const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
          const dotColor = REGION_COLOR_VAR[effectiveRegion] ?? "var(--lm-ink-faint)";
          const isOverridden = Boolean(overrides[ch.index]);
          const isSaved = savedChannelIndex === ch.index;
          const isSelected = selectedChannels.has(ch.index);
          const channelLabel = String(ch.index + 1);

          return (
            <div
              key={ch.index}
              className="lm-chmap-row"
              role="group"
              aria-label={t("device.hue.channelMap.regionRowAriaLabel", { index: channelLabel })}
            >
              <div className="lm-chmap-row-id">
                <button
                  type="button"
                  className={`lm-chmap-row-dot${isSelected ? " is-selected" : ""}`}
                  style={{ ["--lm-chmap-dot-color" as string]: dotColor }}
                  aria-pressed={isSelected}
                  aria-label={t("device.hue.channelMap.rowDotAriaLabel", { index: channelLabel })}
                  onClick={(e) => {
                    toggleSelection(ch.index, e.shiftKey);
                  }}
                />
                <span className="lm-chmap-row-num" aria-hidden>
                  {channelLabel}
                </span>
                <span className="lm-chmap-row-lights">
                  {ch.lightCount === 1
                    ? t("device.hue.channelMap.oneLight")
                    : t("device.hue.channelMap.lights", { count: ch.lightCount })}
                </span>
              </div>

              <div className="lm-chmap-pills" role="radiogroup" aria-label={t("device.hue.channelMap.zonePicker")}>
                {REGIONS.map((region) => {
                  const isActive = effectiveRegion === region;
                  return (
                    <button
                      key={region}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      className={`lm-chmap-pill${isActive ? " is-active" : ""}`}
                      onClick={() => {
                        if (isActive && isOverridden) {
                          handleSetRegion(ch.index, null);
                        } else if (!isActive || !isOverridden) {
                          handleSetRegion(ch.index, region === ch.autoRegion ? null : region);
                        }
                      }}
                    >
                      {regionLabel(region)}
                    </button>
                  );
                })}
              </div>

              <div className="lm-chmap-row-trail">
                {isSaved ? (
                  <span className="lm-chmap-row-saved" aria-live="polite">
                    {t("device.hue.channelMap.saved")}
                  </span>
                ) : isOverridden ? (
                  <button
                    type="button"
                    className="lm-chmap-row-reset"
                    onClick={() => {
                      handleSetRegion(ch.index, null);
                    }}
                    title={t("device.hue.channelMap.resetToAuto")}
                  >
                    {t("device.hue.channelMap.auto")}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Save-to-bridge footer */}
      {hasSaveAction && (
        <div className="lm-chmap-footer">
          <div className="lm-chmap-footer-row">
            <span className="lm-chmap-beta">{t("device.hue.channelMap.beta")}</span>
            <div className="lm-chmap-footer-spacer" />
            <button
              type="button"
              className="lm-device-btn is-primary"
              disabled={isStreaming || isSaving}
              title={isStreaming ? t("device.hue.channelMap.saveToBridgeTooltip") : undefined}
              onClick={() => {
                void handleSaveToBridge();
              }}
            >
              {isSaving ? t("device.hue.channelMap.saving") : t("device.hue.channelMap.saveToBridge")}
            </button>
          </div>
          {saveResult !== null && (
            saveResult.ok ? (
              <div className="lm-chmap-feedback is-ok" role="status" aria-live="polite">
                <span>{t("device.hue.channelMap.savedToBridge")}</span>
              </div>
            ) : (
              <div className="lm-chmap-feedback is-err" role="alert">
                <span>
                  {t("device.hue.channelMap.saveToBridgeError", { code: saveResult.code ?? "" })}
                </span>
                <button
                  type="button"
                  className="lm-chmap-feedback-retry"
                  onClick={() => {
                    void handleSaveToBridge();
                  }}
                >
                  {t("device.hue.channelMap.saveToBridgeErrorRetry")}
                </button>
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// MiniSpatialPreview — kept token-aligned with the main canvas so the room
// list dots read as members of the same family.
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
  const placeholderCount = channelCount ?? 0;

  return (
    <div
      className="lm-chmap-canvas"
      style={{ height: 48, borderRadius: 6 }}
      aria-hidden="true"
    >
      <div className="lm-chmap-canvas-axis is-v" />
      <div className="lm-chmap-canvas-axis is-h" />
      {channels
        ? channels.map((ch, i) => {
            const { left, top } = posToPercent(ch.positionX, ch.positionY);
            const region = (ch.autoRegion as Region) ?? "center";
            const dotColor = REGION_COLOR_VAR[region] ?? "var(--lm-ink-faint)";
            return (
              <span
                key={ch.index ?? i}
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: 8,
                  height: 8,
                  marginLeft: -4,
                  marginTop: -4,
                  borderRadius: "50%",
                  background: dotColor,
                }}
              />
            );
          })
        : Array.from({ length: placeholderCount }, (_, i) => {
            const x = placeholderCount > 1 ? (i / (placeholderCount - 1)) * 2 - 1 : 0;
            const { left, top } = posToPercent(x, 0);
            return (
              <span
                key={i}
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: 8,
                  height: 8,
                  marginLeft: -4,
                  marginTop: -4,
                  borderRadius: "50%",
                  background: "var(--lm-ink-faint, #4d5564)",
                }}
              />
            );
          })}
    </div>
  );
}
