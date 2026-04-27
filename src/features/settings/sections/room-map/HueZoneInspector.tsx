/**
 * HueZoneInspector — properties surface rendered inside `RoomDockPanel`
 * when a Hue zone is the active selection.
 *
 * Successor to `HueZonePropertiesPanel` (still on disk for backward
 * compatibility with anything that imported it directly). The dock
 * version exposes:
 *
 *   - Identity strip: zone name + colored chip (color is paired with
 *     name so it is never the sole status signal).
 *   - Color picker: 6-slot quick palette (`--lm-zone-1..6`) followed by
 *     the SVG-native `HsvColorPicker` from W1-A7.
 *   - Single "size" control (W4-C — room-relative scale): slider +
 *     long-edge metre input hybrid (W4-G). The zone size is authored
 *     as a fraction of the room (1.0 ⇒ zone equals the room; the Rust
 *     validator rejects anything above with `HUE_ZONE_OVERSIZED`).
 *     Both controls write `scaleX` and `scaleY` to the same value so
 *     the zone aspect ratio always mirrors the room ("en boy oranı
 *     değişemez" rule). The metre input edits the room's long edge
 *     (max(width, depth) × scale) so the user can type a concrete
 *     measurement without re-deriving the percentage.
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
   * Room dimensions so the size slider can render a metric read-out
   * ("zone is 2.5m × 2.0m") and clamp against `widthMeters` /
   * `depthMeters`. The zone scale itself is a unitless `[0, 1]` fraction
   * of the room; the metres are derived purely for display.
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

// W4-C — size is room-relative; the slider domain matches the Rust
// validation floor/ceiling in `commands/hue/zone.rs`. `1.0` means the
// zone equals the room (legal); anything above is rejected.
const SCALE_MIN = 0.05;
const SCALE_MAX = 1;
const SCALE_STEP = 0.01;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return SCALE_MIN;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, value));
}

/**
 * Resolve a HueZone's room-relative scale to a single uniform value the
 * size slider can drive. Persisted zones from before W4-C may have
 * `scaleX !== scaleY`; we collapse to the larger axis so the zone never
 * shrinks unexpectedly on first interaction (Rust would reject the
 * asymmetric write anyway). The new authoring path always writes both
 * axes in lockstep, so this only fires once per legacy zone.
 */
function resolveUniformScale(zone: HueZone): number {
  const sx = Number.isFinite(zone.scaleX) ? zone.scaleX : SCALE_MIN;
  const sy = Number.isFinite(zone.scaleY) ? zone.scaleY : SCALE_MIN;
  return clampScale(Math.max(sx, sy));
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

  // W4-C — write `scaleX` and `scaleY` in lockstep so the zone keeps the
  // room aspect ratio. The Rust validator will reject any asymmetric
  // write with `HUE_ZONE_OVERSIZED`; this guarantee on the UI side keeps
  // the validator at the contract boundary, not the hot path.
  const setSize = useCallback(
    (raw: number) => {
      const next = clampScale(raw);
      onUpdate({ scaleX: next, scaleY: next });
    },
    [onUpdate],
  );

  const sizeFraction = resolveUniformScale(zone);
  // Resolve metric read-out: zone covers `sizeFraction` of each room
  // dimension. `widthMeters` / `depthMeters` may be 0 during initial
  // mount before the room map loads — fall back to 0 so the read-out
  // shows "0.0m × 0.0m" instead of NaN.
  const safeWidthM = Math.max(0, roomWidthM);
  const safeDepthM = Math.max(0, roomDepthM);
  const widthM = safeWidthM * sizeFraction;
  const depthM = safeDepthM * sizeFraction;
  const sizePercent = Math.round(sizeFraction * 100);

  // ── W4-G #2 — long-edge metre input (slider + input hybrid) ───────
  // The zone is AR-locked to the room, so a single number expresses the
  // entire footprint. We pick the room's *long* edge as the canonical
  // metre value: typing "5.0" for a 5×4 m room sets scale = 1.0 and the
  // short edge follows automatically (4.0 m). This avoids two redundant
  // inputs in the dock while still letting the user reach an exact
  // measurement instead of dragging the slider in 1 % steps.
  const longEdgeM = Math.max(safeWidthM, safeDepthM);
  const longEdgeMin = SCALE_MIN * longEdgeM;
  const longEdgeMax = SCALE_MAX * longEdgeM;
  const currentLongEdgeM = sizeFraction * longEdgeM;

  const [longEdgeDraft, setLongEdgeDraft] = useState<string>(
    currentLongEdgeM.toFixed(1),
  );
  const [editingLongEdge, setEditingLongEdge] = useState(false);

  // Keep the draft in sync with external changes (slider drag, swatch
  // pick, undo) while the input is *not* focused — same pattern the
  // PropertyBar's NumberInput uses to avoid clobbering an in-flight
  // typed value.
  useEffect(() => {
    if (!editingLongEdge) {
      setLongEdgeDraft(currentLongEdgeM.toFixed(1));
    }
  }, [currentLongEdgeM, editingLongEdge]);

  const commitLongEdge = useCallback(() => {
    setEditingLongEdge(false);
    const parsed = parseFloat(longEdgeDraft);
    if (!Number.isFinite(parsed) || longEdgeM <= 0) {
      setLongEdgeDraft(currentLongEdgeM.toFixed(1));
      return;
    }
    const clampedM = Math.max(longEdgeMin, Math.min(longEdgeMax, parsed));
    const nextFraction = clampScale(clampedM / longEdgeM);
    setLongEdgeDraft((nextFraction * longEdgeM).toFixed(1));
    setSize(nextFraction);
  }, [
    longEdgeDraft,
    longEdgeM,
    longEdgeMin,
    longEdgeMax,
    currentLongEdgeM,
    setSize,
  ]);

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

      {/* Size — W4-C uniform scale (AR-locked to the room) + W4-G long-edge input */}
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`zone-size-${zone.id}`}>
          {t("roomMap.inspector.zoneSize")}
        </label>
        <input
          id={`zone-size-${zone.id}`}
          type="range"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={SCALE_STEP}
          value={sizeFraction}
          onChange={(e) => setSize(parseFloat(e.target.value))}
          className="lm-room-dock-slider"
          aria-valuemin={SCALE_MIN}
          aria-valuemax={SCALE_MAX}
          aria-valuenow={sizeFraction}
          aria-label={t("roomMap.inspector.zoneSize")}
          data-testid="hue-zone-size-slider"
        />
      </div>
      <div className="lm-room-dock-field">
        <label
          className="lm-room-dock-field-label"
          htmlFor={`zone-size-m-${zone.id}`}
        >
          {t("roomMap.inspector.zoneSizeLongEdgeLabel")}
        </label>
        <input
          id={`zone-size-m-${zone.id}`}
          type="number"
          step={0.1}
          min={Number(longEdgeMin.toFixed(2))}
          max={Number(longEdgeMax.toFixed(2))}
          inputMode="decimal"
          className="lm-room-dock-input"
          value={longEdgeDraft}
          aria-label={t("roomMap.inspector.zoneSizeLongEdgeAriaLabel")}
          disabled={longEdgeM <= 0}
          data-testid="hue-zone-size-long-edge-input"
          onFocus={() => setEditingLongEdge(true)}
          onChange={(e) => setLongEdgeDraft(e.target.value)}
          onBlur={commitLongEdge}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitLongEdge();
            } else if (e.key === "Escape") {
              setLongEdgeDraft(currentLongEdgeM.toFixed(1));
              setEditingLongEdge(false);
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
          aria-label={t("roomMap.inspector.zoneSizeMetricAriaLabel", {
            width: widthM.toFixed(2),
            depth: depthM.toFixed(2),
            percent: sizePercent,
          })}
          title={t("roomMap.inspector.zoneSizeMetricAriaLabel", {
            width: widthM.toFixed(2),
            depth: depthM.toFixed(2),
            percent: sizePercent,
          })}
        >
          {t("roomMap.inspector.zoneSizeMetric", {
            width: widthM.toFixed(2),
            depth: depthM.toFixed(2),
          })}
        </span>
      </div>
      <p className="lm-room-dock-field-hint">
        {t("roomMap.inspector.zoneSizeHint")}
      </p>
    </>
  );
}
