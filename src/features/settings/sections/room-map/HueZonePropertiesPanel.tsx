/**
 * HueZonePropertiesPanel — v1.5 W1-A8
 *
 * Inspector panel for the currently selected `HueZone`. Lets the user
 * customise the two UI hint colors carried by the zone:
 *
 *   - `borderColor` — outline of the zone bounds box rendered by
 *     `HueChannelOverlay` while the zone is in scope.
 *   - `centerColor` — fill of the draggable center marker.
 *
 * The colors have NO streaming side effect — they are pure room-map
 * authoring affordances (per `roomMap.ts > HueZone` contract). Persisting
 * them lets the user tell zones apart at a glance even when several
 * overlap on the canvas.
 *
 * The panel mounts the SVG-native `HsvColorPicker` from W1-A7 and a
 * 6-slot quick palette derived from the `--lm-zone-1..6` CSS tokens so
 * matching the design language is one click away.
 *
 * Persistence: the parent receives a `(zoneId, patch)` callback and is
 * responsible for committing to `RoomMapConfig.hueZones` AND mirroring
 * via the `update_hue_zone` Tauri command. The panel itself stays pure.
 */
import { useCallback, useState } from "react";
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
  const [section, setSection] = useState<"border" | "center">("border");

  const borderHex = resolveDisplayHex(zone.borderColor, "#3b82f6");
  const centerHex = resolveDisplayHex(zone.centerColor, "#3b82f6");

  const setBorder = useCallback(
    (hex: string) => onUpdate(zone.id, { borderColor: hex }),
    [zone.id, onUpdate],
  );
  const setCenter = useCallback(
    (hex: string) => onUpdate(zone.id, { centerColor: hex }),
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

      {/* Tab switcher: border vs center */}
      <div className="flex gap-1 text-[10px]">
        <button
          type="button"
          className={[
            "flex-1 rounded px-1.5 py-0.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60",
            section === "border"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
          ].join(" ")}
          aria-pressed={section === "border"}
          onClick={() => setSection("border")}
        >
          {t("roomMap.zoneProperties.borderColor")}
        </button>
        <button
          type="button"
          className={[
            "flex-1 rounded px-1.5 py-0.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60",
            section === "center"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
          ].join(" ")}
          aria-pressed={section === "center"}
          onClick={() => setSection("center")}
        >
          {t("roomMap.zoneProperties.centerColor")}
        </button>
      </div>

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
            onClick={() =>
              section === "border" ? setBorder(swatch.hex) : setCenter(swatch.hex)
            }
          />
        ))}
      </div>

      {/* Picker */}
      <HsvColorPicker
        value={section === "border" ? borderHex : centerHex}
        onChange={section === "border" ? setBorder : setCenter}
        ariaLabel={
          section === "border"
            ? t("roomMap.zoneProperties.borderColor")
            : t("roomMap.zoneProperties.centerColor")
        }
        compact
      />
    </div>
  );
}
