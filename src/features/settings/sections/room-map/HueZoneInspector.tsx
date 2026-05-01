/**
 * HueZoneInspector — properties surface rendered inside `RoomDockPanel`
 * when a Hue zone is the active selection.
 *
 * v1.5 W4-K — single-row header refactor
 * --------------------------------------------------
 * The W4-I version stacked three field rows below the HSV picker (EDGE
 * slider, EDGE metre input, "{edge}m × {edge}m" metric reader) plus an
 * AR hint paragraph and the picker's own hex input + recent strip. On
 * a 320 px dock that stack overflowed: the EDGE-length value collided
 * with the metric reader, the hex input collided with the recent
 * swatches, and the hint wrapped onto the swatches.
 *
 * The fix is structural, not cosmetic: drop the redundant metric
 * reader (the zone is already a square — `{edge}m × {edge}m` adds
 * zero information beyond the EDGE field), suppress HsvColorPicker's
 * built-in hex input, and render a single side-by-side `EDGE … HEX`
 * row. The HSV picker centres in its own block; the recent strip
 * (still owned by HsvColorPicker) trails it; the AR hint is a single
 * muted line at the very bottom.
 *
 * Resulting visual stack inside `.lm-room-dock-inspect`:
 *
 *   1. Header chip — type + zone name + (optional) channel count
 *   2. Range slider — single row, full width
 *   3. EDGE  [n.nn] m   |   HEX  [#XXXXXX]            (single-row pair)
 *   4. Color preset swatches  ──── single row, 6 buttons 22 px
 *   5. HSV picker (compact, centred)
 *   6. RECENT swatches (rendered by HsvColorPicker)
 *   7. Hint paragraph — single line, muted
 *
 * The size authoring contract is unchanged from W4-I: a single edge
 * length in metres → per-axis cube-space scales `scaleX = edge /
 * roomWidthM`, `scaleY = edge / roomDepthM`. The `metric reader`
 * locale keys (`zoneEdgeMetric*`) are dropped — they were the source
 * of the visual collision and carried no information the EDGE field
 * did not already surface.
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
   * persists. They also drive the maximum allowed edge (the room's
   * *short* side). May briefly be `0` during initial mount before the
   * room map loads — the component falls back to safe defaults so
   * nothing renders as NaN.
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

function normaliseHexDraft(raw: string): string | null {
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(withHash)) return null;
  return `#${withHash.slice(1).toLowerCase()}`;
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

  // ── W4-K hex input — Inspector-owned ──────────────────────────────
  // HsvColorPicker still ships its own hex input by default, but we
  // pass `hideHex` so we can render it inline next to the EDGE field
  // and avoid the W4-I overlap. The picker's `recent` strip stays
  // (we render a uniform RECENT row below the SV ring, same as
  // before).
  const [hexDraft, setHexDraft] = useState<string>(borderHex.toUpperCase());
  const [editingHex, setEditingHex] = useState(false);

  // Sync external border changes (preset swatch, picker drag, recent
  // click) into the draft when the input is not focused.
  useEffect(() => {
    if (!editingHex) {
      setHexDraft(borderHex.toUpperCase());
    }
  }, [borderHex, editingHex]);

  const commitHex = useCallback(() => {
    setEditingHex(false);
    const normalised = normaliseHexDraft(hexDraft);
    if (!normalised) {
      setHexDraft(borderHex.toUpperCase());
      return;
    }
    setHexDraft(normalised.toUpperCase());
    if (normalised.toLowerCase() !== borderHex.toLowerCase()) {
      setBorder(normalised);
    }
  }, [hexDraft, borderHex, setBorder]);

  const channelCount = zone.channelIndices?.length ?? 0;

  return (
    <div className="lm-zone-inspector">
      <div className="lm-zone-inspector-h">
        <span className="lm-room-dock-inspect-h-chip">
          <span
            className="lm-room-dock-inspect-h-chip-dot"
            style={{ background: borderHex }}
            aria-hidden
          />
          <span>{t("roomMap.inspector.typeHueZone")}</span>
        </span>
        <span className="lm-zone-inspector-h-name" title={zone.name}>
          {zone.name}
        </span>
        <span className="lm-zone-inspector-h-meta" aria-hidden>
          {t("roomMap.inspector.zoneChannelCount", { count: channelCount })}
        </span>
      </div>

      {/* Range slider — single full-width row above the EDGE/HEX pair.
          aria-label is verbose because the slider value is in metres
          but the visual label "EDGE" sits two rows above. */}
      <div className="lm-zone-inspector-slider-row">
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
          aria-label={t("roomMap.inspector.zoneEdgeAriaLabel")}
          data-testid="hue-zone-size-slider"
        />
      </div>

      {/* EDGE  [n.nn] M   |   HEX  [#XXXXXX]
          Single row; both groups are flex children so the row stays
          one line down to ~280 px before either group wraps. */}
      <div className="lm-zone-inspector-pair">
        <label
          className="lm-zone-inspector-pair-label"
          htmlFor={`zone-size-m-${zone.id}`}
        >
          {t("roomMap.inspector.zoneEdgeShort")}
        </label>
        <input
          id={`zone-size-m-${zone.id}`}
          type="number"
          step={0.05}
          min={Number(minEdgeM.toFixed(2))}
          max={Number(maxEdgeM.toFixed(2))}
          inputMode="decimal"
          className="lm-zone-inspector-num"
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
        <span className="lm-zone-inspector-pair-unit" aria-hidden>
          m
        </span>

        <label
          className="lm-zone-inspector-pair-label lm-zone-inspector-pair-label--hex"
          htmlFor={`zone-hex-${zone.id}`}
        >
          {t("roomMap.inspector.zoneHexShort")}
        </label>
        <input
          id={`zone-hex-${zone.id}`}
          type="text"
          spellCheck={false}
          className="lm-zone-inspector-hex"
          value={hexDraft}
          aria-label={t("roomMap.inspector.zoneHexAriaLabel")}
          data-testid="hue-zone-hex-input"
          onFocus={() => setEditingHex(true)}
          onChange={(e) => setHexDraft(e.target.value.toUpperCase())}
          onBlur={commitHex}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitHex();
            } else if (e.key === "Escape") {
              setHexDraft(borderHex.toUpperCase());
              setEditingHex(false);
            }
          }}
        />
      </div>

      {/* Color preset swatches — single row, 6 buttons. Tap target is
          22 × 22 px (the dock honours min-height through the row, but
          we still keep the floor so iPad-style touch input remains
          usable when the editor lands on tablet form factors). */}
      <div className="lm-zone-inspector-swatches" role="list">
        {ZONE_PALETTE.map((swatch) => {
          const active = borderHex.toLowerCase() === swatch.hex.toLowerCase();
          return (
            <button
              key={swatch.name}
              type="button"
              role="listitem"
              title={t("roomMap.zoneProperties.swatchAriaLabel", { name: swatch.name })}
              aria-label={t("roomMap.zoneProperties.swatchAriaLabel", { name: swatch.name })}
              aria-pressed={active}
              className={`lm-zone-inspector-swatch${active ? " is-active" : ""}`}
              style={{ background: swatch.cssVar }}
              onClick={() => setBorder(swatch.hex)}
            />
          );
        })}
      </div>

      {/* HSV picker — centred in its own block. `hideHex` so the
          Inspector owns the hex input above; the picker still emits
          its RECENT strip below (no need to duplicate it here). */}
      <div className="lm-zone-inspector-picker">
        <HsvColorPicker
          value={borderHex}
          onChange={setBorder}
          ariaLabel={t("roomMap.zoneProperties.color")}
          hideHex
          compact
        />
      </div>

      <p className="lm-zone-inspector-hint">
        {t("roomMap.inspector.zoneSizeHint")}
      </p>
    </div>
  );
}
