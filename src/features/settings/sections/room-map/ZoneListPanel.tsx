import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ZoneDefinition } from "../../../../shared/contracts/roomMap";

interface ZoneListPanelProps {
  zones: ZoneDefinition[];
  activeZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onAddZone: () => void;
  onDeleteZone: (zoneId: string) => void;
  onRenameZone: (zoneId: string, name: string) => void;
}

export const ZONE_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-purple-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
] as const;

export function getZoneColor(index: number): string {
  return ZONE_COLORS[index % ZONE_COLORS.length];
}

export function ZoneListPanel({
  zones,
  activeZoneId,
  onSelectZone,
  onAddZone,
  onDeleteZone,
  onRenameZone,
}: ZoneListPanelProps) {
  const { t } = useTranslation("common");
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const btnBase =
    "px-2 py-0.5 text-[11px] font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60";
  const btnActive =
    "text-slate-700 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800";

  function handleStartEdit(zone: ZoneDefinition) {
    setEditingZoneId(zone.id);
    setEditValue(zone.name);
  }

  function handleCommitEdit(zone: ZoneDefinition, zoneIndex: number) {
    const name = editValue.trim() || t("roomMap.zones.defaultName", { N: String(zoneIndex + 1) });
    onRenameZone(zone.id, name);
    setEditingZoneId(null);
    setEditValue("");
  }

  function handleRowClick(zone: ZoneDefinition) {
    if (activeZoneId === zone.id) {
      onSelectZone(null);
    } else {
      onSelectZone(zone.id);
    }
  }

  return (
    <div className="border-t border-slate-200/70 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 max-h-[160px] overflow-y-auto px-4 py-3">
      {/* Header row */}
      <div className="flex items-center mb-1">
        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">
          {t("roomMap.zones.panelTitle")}
        </span>
        <button
          className={`${btnBase} ${btnActive} ml-auto`}
          onClick={onAddZone}
        >
          {t("roomMap.zones.addZoneButton")}
        </button>
      </div>

      {/* Zone list */}
      {zones.length === 0 ? (
        <p className="text-[11px] text-slate-400 dark:text-zinc-500 py-2 text-center">
          {t("roomMap.zones.emptyPanel")}
        </p>
      ) : (
        <ul>
          {zones.map((zone, zoneIndex) => {
            const isActive = activeZoneId === zone.id;
            const isEditing = editingZoneId === zone.id;
            const lightCount = zone.channelIndices.length;

            return (
              <li
                key={zone.id}
                className={[
                  "py-1 flex items-center gap-2 cursor-pointer rounded",
                  isActive ? "bg-slate-100 dark:bg-zinc-800" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => handleRowClick(zone)}
              >
                {/* Color chip */}
                <span
                  className={`w-3 h-3 rounded-full shrink-0 ${getZoneColor(zoneIndex)}`}
                />

                {/* Zone name — inline edit on double-click */}
                {isEditing ? (
                  <input
                    autoFocus
                    className="bg-transparent border-b border-slate-300 dark:border-zinc-600 text-[11px] text-slate-800 dark:text-zinc-200 focus:outline-none focus:border-cyan-400 flex-1"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleCommitEdit(zone, zoneIndex)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleCommitEdit(zone, zoneIndex);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="text-[11px] text-slate-800 dark:text-zinc-200 flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(zone);
                    }}
                  >
                    {zone.name}
                  </span>
                )}

                {/* Light count badge */}
                <span className="text-[10px] text-slate-400 dark:text-zinc-500 shrink-0">
                  {lightCount === 1
                    ? t("roomMap.zones.lightCountOne")
                    : t("roomMap.zones.lightCount", { N: String(lightCount) })}
                </span>

                {/* Delete button */}
                <button
                  className="text-slate-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 text-[11px] shrink-0 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 rounded"
                  aria-label={t("roomMap.zones.deleteAriaLabel", { name: zone.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteZone(zone.id);
                  }}
                >
                  x
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
