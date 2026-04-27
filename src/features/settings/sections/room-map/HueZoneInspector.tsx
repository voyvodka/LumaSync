/**
 * HueZoneInspector — properties surface rendered inside `RoomDockPanel`
 * when a Hue zone is the active selection.
 *
 * v1.5 W4-I — physical 1:1 metric square authoring
 * --------------------------------------------------
 * Successor to the W4-C "room-relative AR-locked" surface. The user
 * feedback (post-W4-G manual test) was that an AR-locked zone in a
 * non-square room renders as a rectangle on the metric canvas — the
 * Hue native cube is symmetric (`±1` per axis), but the canvas paints
 * `scaleX * roomWidthM` wide and `scaleY * roomDepthM` deep, so cube-
 * space squares stretch with the room. The W4-I revision drops the
 * uniform AR lock and authors zones as **physical 1:1 metric squares**:
 *
 *   - Single user input: edge length in metres (the long-edge metre
 *     control from W4-G, repurposed without "long" framing).
 *   - Maximum edge: `min(roomWidthM, roomDepthM)` — the largest square
 *     that still fits inside the room footprint.
 *   - Per-axis cube-space scale derived from the edge:
 *       scaleX = edge_m / roomWidthM
 *       scaleY = edge_m / roomDepthM
 *     so the zone bounds box paints as a true square in metres.
 *   - The Hue ±1 zone-relative cube is unchanged. Channels keep
 *     positioning relative to the zone center via
 *     `world = center + scale * relative`.
 *
 * Backend (Rust `commands/hue/zone.rs`) validates each axis
 * independently against `[0.05, 1.0]` plus the cube-overflow
 * invariant — the AR lock is gone there too.
 *
 * Other dock surfaces (color picker, swatches, channel list) are
 * unchanged from W4-C / W4-G.
 *
 *  `scaleZ` is reserved for a future depth UI; we keep the persisted
 *  value untouched.
 *
 * The component receives a single `(patch: Partial<HueZone>) => void`
 * callback so the parent (`RoomMapEditor` via `RoomDockPanel`) drives
 * the optimistic-write + Tauri-mirror flow. Bug #51: `centerColor` is
 * never authored from this surface (deprecated optional in the
 * contract).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueZone } from "../../../../shared/contracts/roomMap";
import { HsvColorPicker } from "../../../../shared/ui/HsvColorPicker";

interface HueZoneInspectorProps {
  zone: HueZone;
  onUpdate: (patch: Partial<HueZone>) => void;
  /**
   * Room dimensions are required to translate the user's edge-length
   * (metres) into the per-axis Hue cube-space scales the bridge
   * persists. They also drive the metric read-out and the maximum
   * allowed edge (the room's *short* side). May briefly be `0` during
   * initial mount before the room map loads — the component falls back
   * to safe defaults so nothing renders as NaN.
   */
  roomWidthM: number;
  roomDepthM: number;
}

const ZONE_PALETTE: Array<{ name: string; hex: string; cssVar: string }> = [
  { name: "blue", hex: "#3b82f6", cssVar: "var(--lm-zone-1)" },
  { name: "emerald", hex: "#10b981", cssVar: "var(--lm-zone-2)" },
  { name: "purple", hex: "#a855f7", cssVar: "var(--lm-zone-3)" },
  { name: "amber", hex: "#f59e0b", cssVar: "var(--lm-zone-4)" },
  { name: "rose", hex: "#f43f5e", cssVar: "var(--lm-zone-5)" },
  { name: "cyan", hex: "#06b6d4", cssVar: "var(--lm-zone-6)" },
];

function resolveDisplayHex(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  const palette = ZONE_PALETTE.find((p) => p.cssVar === value);
  if (palette) return palette.hex;
  return fallback;
}

// W4-I — per-axis cube-space scale band. Mirrors `commands/hue/zone.rs`
// (`HUE_ZONE_SCALE_MIN` / `HUE_ZONE_SCALE_MAX`). The slider edits a
// physical edge in metres; we derive cube-space scales from it but
// still clamp each axis through this band before writing.
const SCALE_MIN = 0.05;
const SCALE_MAX = 1;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return SCALE_MIN;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, value));
}

/**
 * Resolve the current physical edge length (metres) of the zone from
 * its persisted cube-space scales. The zone is authored as a physical
 * square, so `scaleX * roomWidthM` and `scaleY * roomDepthM` should be
 * approximately equal — but legacy zones (pre-W4-I, or any third-party
 * write) may carry asymmetric values. We pick the *minimum* of the two
 * physical edges so the zone visually fits inside its persisted bounds
 * on first interaction, never spilling outside the room.
 */
function resolvePhysicalEdgeM(zone: HueZone, roomWidthM: number, roomDepthM: number): number {
  if (roomWidthM <= 0 || roomDepthM <= 0) return 0;
  const sx = Number.isFinite(zone.scaleX) ? zone.scaleX : SCALE_MIN;
  const sy = Number.isFinite(zone.scaleY) ? zone.scaleY : SCALE_MIN;
  const xEdge = Math.max(0, sx) * roomWidthM;
  const yEdge = Math.max(0, sy) * roomDepthM;
  return Math.min(xEdge, yEdge);
}

export function HueZoneInspector({
  zone,
  onUpdate,
  roomWidthM,
  roomDepthM,
}: HueZoneInspectorProps) {
  const { t } = useTranslation("common");
  const borderHex = resolveDisplayHex(zone.borderColor, "#3b82f6");

  const setBorder = useCallback(
    (hex: string) => onUpdate({ borderColor: hex }),
    [onUpdate],
  );

  const safeWidthM = Math.max(0, roomWidthM);
  const safeDepthM = Math.max(0, roomDepthM);
  // The largest square that still fits inside the room footprint.
  // This becomes both the slider/input maximum and the metric ceiling
  // of the zone's edge. When dimensions have not loaded yet we fall
  // back to `0` — the input is then disabled to avoid divide-by-zero
  // in the cube-space derivation.
  const maxEdgeM = Math.min(safeWidthM, safeDepthM);
  // The physical floor mirrors the Rust per-axis floor: `SCALE_MIN`
  // applied to whichever axis has the smaller room dimension. In a
  // 5×4 m room that gives `0.05 × 4 = 0.20 m` — small enough to author
  // a single-bulb zone, large enough that the Hue ±1 cube still has
  // useful resolution.
  const minEdgeM = SCALE_MIN * maxEdgeM;
  const currentEdgeM = resolvePhysicalEdgeM(zone, safeWidthM, safeDepthM);

  // ── W4-I — single edge-length input drives both axes ─────────────
  // The slider range is in metres, not a unitless fraction. We convert
  // the metre value back to per-axis cube-space scales so the bridge
  // can keep its native ±1 frame. In a square room both axes resolve
  // to the same scale; in a non-square room they diverge intentionally
  // so the zone paints as a true physical square on the canvas.
  const setEdgeM = useCallback(
    (rawMetres: number) => {
      if (maxEdgeM <= 0) return;
      const clampedM = Math.max(minEdgeM, Math.min(maxEdgeM, rawMetres));
      const sx = clampScale(clampedM / safeWidthM);
      const sy = clampScale(clampedM / safeDepthM);
      onUpdate({ scaleX: sx, scaleY: sy });
    },
    [maxEdgeM, minEdgeM, safeWidthM, safeDepthM, onUpdate],
  );

  const [edgeDraft, setEdgeDraft] = useState<string>(currentEdgeM.toFixed(2));
  const [editingEdge, setEditingEdge] = useState(false);

  // Keep the draft in sync with external changes (slider drag, swatch
  // pick, undo) while the input is *not* focused — same pattern the
  // PropertyBar's NumberInput uses to avoid clobbering an in-flight
  // typed value.
  useEffect(() => {
    if (!editingEdge) {
      setEdgeDraft(currentEdgeM.toFixed(2));
    }
  }, [currentEdgeM, editingEdge]);

  const commitEdge = useCallback(() => {
    setEditingEdge(false);
    const parsed = parseFloat(edgeDraft);
    if (!Number.isFinite(parsed) || maxEdgeM <= 0) {
      setEdgeDraft(currentEdgeM.toFixed(2));
      return;
    }
    const clampedM = Math.max(minEdgeM, Math.min(maxEdgeM, parsed));
    setEdgeDraft(clampedM.toFixed(2));
    setEdgeM(clampedM);
  }, [edgeDraft, maxEdgeM, minEdgeM, currentEdgeM, setEdgeM]);

  return (
    <>
      <div className="lm-room-dock-inspect-h">
        <span className="lm-room-dock-inspect-h-chip">
          <span
            className="lm-room-dock-inspect-h-chip-dot"
            style={{ background: borderHex }}
            aria-hidden
          />
          <span>{t("roomMap.inspector.typeHueZone")}</span>
        </span>
        <span className="sub" title={zone.name}>
          {zone.name}
        </span>
      </div>

      {/* Color block */}
      <div className="lm-room-dock-field" style={{ alignItems: "flex-start" }}>
        <span className="lm-room-dock-field-label" style={{ paddingTop: 2 }}>
          {t("roomMap.zoneProperties.color")}
        </span>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="list">
            {ZONE_PALETTE.map((swatch) => (
              <button
                key={swatch.name}
                type="button"
                role="listitem"
                title={t("roomMap.zoneProperties.swatchAriaLabel", { name: swatch.name })}
                aria-label={t("roomMap.zoneProperties.swatchAriaLabel", { name: swatch.name })}
                className="lm-room-dock-row-action"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 4,
                  background: swatch.cssVar,
                  border: "1px solid var(--lm-line-2)",
                  opacity: 1,
                }}
                onClick={() => setBorder(swatch.hex)}
              />
            ))}
          </div>
          <HsvColorPicker
            value={borderHex}
            onChange={setBorder}
            ariaLabel={t("roomMap.zoneProperties.color")}
            compact
          />
        </div>
      </div>

      {/* Size — W4-I single edge length (metres). Drives both axes so
          the zone paints as a physical 1:1 square on the canvas. */}
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`zone-size-${zone.id}`}>
          {t("roomMap.inspector.zoneSize")}
        </label>
        <input
          id={`zone-size-${zone.id}`}
          type="range"
          min={Number(minEdgeM.toFixed(2))}
          max={Number(maxEdgeM.toFixed(2))}
          step={0.05}
          value={currentEdgeM}
          onChange={(e) => setEdgeM(parseFloat(e.target.value))}
          disabled={maxEdgeM <= 0}
          className="lm-room-dock-slider"
          aria-valuemin={minEdgeM}
          aria-valuemax={maxEdgeM}
          aria-valuenow={currentEdgeM}
          aria-label={t("roomMap.inspector.zoneSize")}
          data-testid="hue-zone-size-slider"
        />
      </div>
      <div className="lm-room-dock-field">
        <label
          className="lm-room-dock-field-label"
          htmlFor={`zone-size-m-${zone.id}`}
        >
          {t("roomMap.inspector.zoneEdgeLabel")}
        </label>
        <input
          id={`zone-size-m-${zone.id}`}
          type="number"
          step={0.05}
          min={Number(minEdgeM.toFixed(2))}
          max={Number(maxEdgeM.toFixed(2))}
          inputMode="decimal"
          className="lm-room-dock-input"
          value={edgeDraft}
          aria-label={t("roomMap.inspector.zoneEdgeAriaLabel")}
          disabled={maxEdgeM <= 0}
          data-testid="hue-zone-size-edge-input"
          onFocus={() => setEditingEdge(true)}
          onChange={(e) => setEdgeDraft(e.target.value)}
          onBlur={commitEdge}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdge();
            } else if (e.key === "Escape") {
              setEdgeDraft(currentEdgeM.toFixed(2));
              setEditingEdge(false);
            }
          }}
        />
        <span className="lm-room-dock-field-unit">m</span>
      </div>
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label" aria-hidden>
          {/* spacer keeps the metric read-out aligned with the inputs */}
        </span>
        <span
          className="lm-room-dock-field-value"
          aria-label={t("roomMap.inspector.zoneEdgeMetricAriaLabel", {
            edge: currentEdgeM.toFixed(2),
          })}
          title={t("roomMap.inspector.zoneEdgeMetricAriaLabel", {
            edge: currentEdgeM.toFixed(2),
          })}
        >
          {t("roomMap.inspector.zoneEdgeMetric", {
            edge: currentEdgeM.toFixed(2),
          })}
        </span>
      </div>
      <p className="lm-room-dock-field-hint">
        {t("roomMap.inspector.zoneSizeHint")}
      </p>
    </>
  );
}
