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
 *   - Scale sliders: `scaleX` and `scaleY` (range 0.05 – 1.0). Lets the
 *     user resize a zone without diving into the canvas — keyboard
 *     friendly. `scaleZ` is reserved for future depth UI; we keep the
 *     persisted value untouched.
 *
 * The component receives a single `(patch: Partial<HueZone>) => void`
 * callback so the parent (`RoomMapEditor` via `RoomDockPanel`) drives
 * the optimistic-write + Tauri-mirror flow. Bug #51: `centerColor` is
 * never authored from this surface (deprecated optional in the
 * contract).
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { HueZone } from "../../../../shared/contracts/roomMap";
import { HsvColorPicker } from "../../../../shared/ui/HsvColorPicker";

interface HueZoneInspectorProps {
  zone: HueZone;
  onUpdate: (patch: Partial<HueZone>) => void;
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

const SCALE_MIN = 0.05;
const SCALE_MAX = 1;
const SCALE_STEP = 0.01;

function clampScale(value: number): number {
  if (Number.isNaN(value)) return SCALE_MIN;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, value));
}

export function HueZoneInspector({ zone, onUpdate }: HueZoneInspectorProps) {
  const { t } = useTranslation("common");
  const borderHex = resolveDisplayHex(zone.borderColor, "#3b82f6");

  const setBorder = useCallback(
    (hex: string) => onUpdate({ borderColor: hex }),
    [onUpdate],
  );

  const setScaleX = useCallback(
    (raw: number) => onUpdate({ scaleX: clampScale(raw) }),
    [onUpdate],
  );

  const setScaleY = useCallback(
    (raw: number) => onUpdate({ scaleY: clampScale(raw) }),
    [onUpdate],
  );

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

      {/* Scale X */}
      <div className="lm-room-dock-field">
        <label
          className="lm-room-dock-field-label"
          htmlFor={`scale-x-${zone.id}`}
        >
          {t("roomMap.inspector.scaleX")}
        </label>
        <input
          id={`scale-x-${zone.id}`}
          type="range"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={SCALE_STEP}
          value={zone.scaleX}
          onChange={(e) => setScaleX(parseFloat(e.target.value))}
          className="lm-room-dock-slider"
          aria-valuemin={SCALE_MIN}
          aria-valuemax={SCALE_MAX}
          aria-valuenow={zone.scaleX}
        />
        <span className="lm-room-dock-field-value">{zone.scaleX.toFixed(2)}</span>
      </div>

      {/* Scale Y */}
      <div className="lm-room-dock-field">
        <label
          className="lm-room-dock-field-label"
          htmlFor={`scale-y-${zone.id}`}
        >
          {t("roomMap.inspector.scaleY")}
        </label>
        <input
          id={`scale-y-${zone.id}`}
          type="range"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={SCALE_STEP}
          value={zone.scaleY}
          onChange={(e) => setScaleY(parseFloat(e.target.value))}
          className="lm-room-dock-slider"
          aria-valuemin={SCALE_MIN}
          aria-valuemax={SCALE_MAX}
          aria-valuenow={zone.scaleY}
        />
        <span className="lm-room-dock-field-value">{zone.scaleY.toFixed(2)}</span>
      </div>
    </>
  );
}
