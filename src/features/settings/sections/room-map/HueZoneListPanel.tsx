/**
 * HueZoneListPanel — v1.5 W1-A5
 *
 * Lists Hue zones (`HueZone[]`, see `roomMap.ts`) inside the room-map
 * editor's right sidebar. Each row groups the zone header with its
 * assigned channel indices nested underneath; channels that have no
 * `zoneId` fall under an "Unassigned" pseudo-group so the user can see
 * everything at a glance without flipping tabs.
 *
 * Scope:
 * - Pure presentation. CRUD / drag handlers are wired by the parent
 *   (`RoomMapEditor`) so the panel stays compatible with the rest of
 *   the W1-A6/W1-A8 flow without owning Tauri invokes itself.
 * - Empty state surfaces an inline CTA so the right rail is never an
 *   empty hole when the user has not authored any zone yet.
 *
 * A11y:
 * - Buttons keep the amber focus ring (`focus-visible:ring-amber-400/60`)
 *   and `aria-label` for icon-only delete actions.
 * - Color chips render BOTH the zone color AND the zone name so color
 *   is never the sole status signal.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  HueChannelPlacement,
  HueZone,
} from "../../../../shared/contracts/roomMap";

interface HueZoneListPanelProps {
  /** All Hue zones authored on the active room map. */
  zones: HueZone[];
  /** All Hue channel placements — used to nest channels under their zone. */
  channels: HueChannelPlacement[];
  activeZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onAddZone: () => void;
  onDeleteZone: (zoneId: string) => void;
  onRenameZone: (zoneId: string, name: string) => void;
  /** Called when the user clicks an indented channel row. */
  onSelectChannel?: (channelIndex: number) => void;
  /** When true, the "+ Add zone" CTA stays disabled (no entertainment area). */
  addZoneDisabled?: boolean;
  /** Tooltip shown on the disabled add CTA. */
  addZoneDisabledTooltip?: string;
}

/** Default zone palette — matches `--lm-zone-1..6` CSS tokens. */
const ZONE_COLOR_TOKENS = [
  "var(--lm-zone-1)",
  "var(--lm-zone-2)",
  "var(--lm-zone-3)",
  "var(--lm-zone-4)",
  "var(--lm-zone-5)",
  "var(--lm-zone-6)",
];

export function getHueZoneColor(zone: HueZone, zoneIndex: number): string {
  if (zone.borderColor) return zone.borderColor;
  return ZONE_COLOR_TOKENS[zoneIndex % ZONE_COLOR_TOKENS.length];
}

export function HueZoneListPanel({
  zones,
  channels,
  activeZoneId,
  onSelectZone,
  onAddZone,
  onDeleteZone,
  onRenameZone,
  onSelectChannel,
  addZoneDisabled = false,
  addZoneDisabledTooltip,
}: HueZoneListPanelProps) {
  const { t } = useTranslation("common");
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  function handleStartEdit(zone: HueZone) {
    setEditingZoneId(zone.id);
    setEditValue(zone.name);
  }

  function handleCommitEdit(zone: HueZone, zoneIndex: number) {
    const fallback = t("roomMap.hueZones.defaultName", { N: String(zoneIndex + 1) });
    const name = editValue.trim() || fallback;
    onRenameZone(zone.id, name);
    setEditingZoneId(null);
    setEditValue("");
  }

  // Bucket channels by zone id (channels without a zone go under "unassigned").
  const channelsByZone = new Map<string, HueChannelPlacement[]>();
  const unassigned: HueChannelPlacement[] = [];
  for (const ch of channels) {
    if (ch.zoneId && zones.some((z) => z.id === ch.zoneId)) {
      const bucket = channelsByZone.get(ch.zoneId) ?? [];
      bucket.push(ch);
      channelsByZone.set(ch.zoneId, bucket);
    } else {
      unassigned.push(ch);
    }
  }

  const btnBase =
    "px-2 py-0.5 text-[11px] font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60";

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {/* Header row with + Add zone CTA */}
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          {t("roomMap.hueZones.title")}
        </span>
        <button
          type="button"
          className={`${btnBase} ${
            addZoneDisabled
              ? "cursor-not-allowed text-zinc-600 opacity-50"
              : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
          onClick={addZoneDisabled ? undefined : onAddZone}
          aria-disabled={addZoneDisabled}
          title={addZoneDisabled ? addZoneDisabledTooltip : undefined}
        >
          {t("roomMap.hueZones.addAction")}
        </button>
      </div>

      {/* Empty state */}
      {zones.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <p className="text-[10px] text-zinc-500">{t("roomMap.hueZones.empty")}</p>
          <button
            type="button"
            className={`${btnBase} ${
              addZoneDisabled
                ? "cursor-not-allowed text-zinc-600 opacity-50"
                : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            }`}
            onClick={addZoneDisabled ? undefined : onAddZone}
            aria-disabled={addZoneDisabled}
            title={addZoneDisabled ? addZoneDisabledTooltip : undefined}
          >
            {t("roomMap.hueZones.emptyCta")}
          </button>
        </div>
      ) : (
        <ul className="space-y-1">
          {zones.map((zone, zoneIndex) => {
            const isActive = activeZoneId === zone.id;
            const isEditing = editingZoneId === zone.id;
            const zoneColor = getHueZoneColor(zone, zoneIndex);
            const zoneChannels = channelsByZone.get(zone.id) ?? [];
            return (
              <li key={zone.id} className="rounded">
                {/* Zone header row */}
                <div
                  className={[
                    "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px]",
                    isActive
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-300 hover:bg-zinc-800/50",
                  ].join(" ")}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
                  onClick={() => onSelectZone(isActive ? null : zone.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectZone(isActive ? null : zone.id);
                    }
                  }}
                >
                  {/* Color chip — paired with zone name (color is not the sole signal) */}
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/40"
                    style={{ background: zoneColor }}
                    aria-hidden
                  />
                  {isEditing ? (
                    <input
                      autoFocus
                      className="flex-1 min-w-0 border-b border-zinc-600 bg-transparent text-[11px] focus:border-amber-400 focus:outline-none"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleCommitEdit(zone, zoneIndex)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleCommitEdit(zone, zoneIndex);
                        }
                        if (e.key === "Escape") setEditingZoneId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="flex-1 truncate"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleStartEdit(zone);
                      }}
                    >
                      {zone.name}
                    </span>
                  )}
                  <span className="shrink-0 text-[9px] text-zinc-500">
                    {zoneChannels.length === 1
                      ? t("roomMap.hueZones.lightCountOne")
                      : t("roomMap.hueZones.lightCount", { N: String(zoneChannels.length) })}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded text-[11px] leading-none text-zinc-500 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                    aria-label={t("roomMap.hueZones.deleteAriaLabel", { name: zone.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteZone(zone.id);
                    }}
                  >
                    ×
                  </button>
                </div>

                {/* Nested channel rows */}
                {zoneChannels.length > 0 && (
                  <ul className="ml-4 mt-0.5 border-l border-zinc-800 pl-2">
                    {zoneChannels.map((ch) => (
                      <li
                        key={ch.channelIndex}
                        className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectChannel?.(ch.channelIndex);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectChannel?.(ch.channelIndex);
                          }
                        }}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: zoneColor, opacity: 0.6 }}
                          aria-hidden
                        />
                        <span className="flex-1 truncate">
                          {ch.label ??
                            t("roomMap.hueChannel.defaultLabel", {
                              index: String(ch.channelIndex + 1),
                            })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}

          {/* Unassigned channels group */}
          {unassigned.length > 0 && (
            <li className="mt-2 rounded border border-dashed border-zinc-800/60 px-2 py-1">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                {t("roomMap.hueZones.unassignedTitle")}
                <span className="text-[9px] text-zinc-600">({unassigned.length})</span>
              </div>
              <ul>
                {unassigned.map((ch) => (
                  <li
                    key={ch.channelIndex}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectChannel?.(ch.channelIndex)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectChannel?.(ch.channelIndex);
                      }
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600"
                      aria-hidden
                    />
                    <span className="flex-1 truncate">
                      {ch.label ??
                        t("roomMap.hueChannel.defaultLabel", {
                          index: String(ch.channelIndex + 1),
                        })}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
