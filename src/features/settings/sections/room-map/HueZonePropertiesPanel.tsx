/**
 * HueZonePropertiesPanel — v1.5 W1-A8
 *
 * Inspector panel for the currently selected `HueZone`. Lets the user
 * customise the zone's UI hint color carried by `HueZone.borderColor`,
 * which the room-map editor uses to render:
 *
 *   - the dashed bounds box outline,
 *   - the draggable center marker fill,
 *   - the ring around channels bound to the zone, and
 *   - the chip in `HueZoneListPanel`.
 *
 * Bug #51 — earlier revisions exposed a separate `centerColor` swatch
 * alongside `borderColor`. Manual testing showed the second color was
 * confusing (UI authors expect one identity color per zone) AND its
 * value never propagated to the overlay (the bounds box always read
 * `borderColor`). We collapsed the panel onto a single "Color" picker
 * driven by `borderColor`. `HueZone.centerColor` is kept on the
 * contract for backward compatibility (existing persisted configs still
 * deserialise) but is no longer authored or read by the editor.
 *
 * The panel mounts the SVG-native `HsvColorPicker` from W1-A7 and a
 * 6-slot quick palette derived from the `--lm-zone-1..6` CSS tokens so
 * matching the design language is one click away.
 *
 * Persistence: the parent receives a `(zoneId, patch)` callback and is
 * responsible for committing to `RoomMapConfig.hueZones` AND mirroring
 * via the `update_hue_zone` Tauri command. The panel itself stays pure.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { HueZone } from "../../../../shared/contracts/roomMap";
import { HsvColorPicker } from "../../../../shared/ui/HsvColorPicker";

interface HueZonePropertiesPanelProps {
  zone: HueZone;
  onUpdate: (zoneId: string, patch: Partial<HueZone>) => void;
}

/**
 * 6-slot palette aligned with the `--lm-zone-1..6` CSS tokens. Resolved
 * to concrete hex strings so the swatches render even before the picker
 * popover opens (the tokens are the single source of truth in
 * `src/styles.css`; we mirror their hex values here for the palette UI
 * only).
 */
const ZONE_PALETTE: Array<{ name: string; hex: string; cssVar: string }> = [
  { name: "blue", hex: "#3b82f6", cssVar: "var(--lm-zone-1)" },
  { name: "emerald", hex: "#10b981", cssVar: "var(--lm-zone-2)" },
  { name: "purple", hex: "#a855f7", cssVar: "var(--lm-zone-3)" },
  { name: "amber", hex: "#f59e0b", cssVar: "var(--lm-zone-4)" },
  { name: "rose", hex: "#f43f5e", cssVar: "var(--lm-zone-5)" },
  { name: "cyan", hex: "#06b6d4", cssVar: "var(--lm-zone-6)" },
];

/** Resolve any token value to a concrete hex for the picker, falling back to white. */
function resolveDisplayHex(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  // CSS var fallback — match against the palette token list.
  const palette = ZONE_PALETTE.find((p) => p.cssVar === value);
  if (palette) return palette.hex;
  return fallback;
}

export function HueZonePropertiesPanel({ zone, onUpdate }: HueZonePropertiesPanelProps) {
  const { t } = useTranslation("common");

  const borderHex = resolveDisplayHex(zone.borderColor, "#3b82f6");

  const setBorder = useCallback(
    (hex: string) => onUpdate(zone.id, { borderColor: hex }),
    [zone.id, onUpdate],
  );

  return (
    <div
      className="flex flex-col gap-2 border-t border-zinc-800 bg-zinc-900/90 px-3 py-2"
      role="group"
      aria-label={t("roomMap.zoneProperties.title")}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          {t("roomMap.zoneProperties.title")}
        </span>
        <span className="truncate text-[10px] text-zinc-400">{zone.name}</span>
      </div>

      <span className="text-[10px] font-semibold text-zinc-300">
        {t("roomMap.zoneProperties.color")}
      </span>

      {/* Quick palette */}
      <div className="flex flex-wrap gap-1.5" role="list">
        {ZONE_PALETTE.map((swatch) => (
          <button
            key={swatch.name}
            type="button"
            role="listitem"
            title={t("roomMap.zoneProperties.swatchAriaLabel", { name: swatch.name })}
            aria-label={t("roomMap.zoneProperties.swatchAriaLabel", { name: swatch.name })}
            className="h-5 w-5 rounded border border-zinc-700 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            style={{ background: swatch.cssVar }}
            onClick={() => setBorder(swatch.hex)}
          />
        ))}
      </div>

      {/* Picker */}
      <HsvColorPicker
        value={borderHex}
        onChange={setBorder}
        ariaLabel={t("roomMap.zoneProperties.color")}
        compact
      />
    </div>
  );
}
