import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type {
  RoomMapConfig,
  ZoneDefinition,
} from "../../../../shared/contracts/roomMap";
import { getZoneColor } from "./ZoneListPanel";

type ObjectEntry = {
  id: string;
  type: "tv" | "furniture" | "usb" | "hue" | "image";
  label: string;
  locked?: boolean;
};

interface ObjectListPanelProps {
  config: RoomMapConfig;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRenameFurniture: (id: string, label: string) => void;
  onToggleLock?: (id: string) => void;
  // Zone props
  zones: ZoneDefinition[];
  activeZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onAddZone: () => void;
  onDeleteZone: (zoneId: string) => void;
  onRenameZone: (zoneId: string, name: string) => void;
}

const TYPE_COLORS: Record<ObjectEntry["type"], string> = {
  tv: "bg-violet-500",
  furniture: "bg-amber-500",
  usb: "bg-cyan-500",
  hue: "bg-white border border-zinc-400",
  image: "bg-slate-500",
};

function buildObjectList(config: RoomMapConfig, t: (key: string, opts?: Record<string, string>) => string): ObjectEntry[] {
  const entries: ObjectEntry[] = [];

  // Image layers
  for (const layer of config.imageLayers) {
    entries.push({ id: `img-${layer.id}`, type: "image", label: layer.label, locked: layer.locked });
  }

  if (config.tvAnchor) {
    entries.push({ id: "tv", type: "tv", label: t("roomMap.objectPanel.tvLabel"), locked: config.tvAnchor.locked });
  }

  for (const f of config.furniture) {
    entries.push({
      id: `furniture-${f.id}`,
      type: "furniture",
      label: f.label ?? t(`roomMap.furniture.type.${f.type}`),
      locked: f.locked,
    });
  }

  for (const s of config.usbStrips) {
    entries.push({
      id: `usb-${s.stripId}`,
      type: "usb",
      label: t("roomMap.objectPanel.ledLabel", { count: String(s.ledCount) }),
      locked: s.locked,
    });
  }

  for (const ch of config.hueChannels) {
    entries.push({
      id: `hue-${ch.channelIndex}`,
      type: "hue",
      label: ch.label ?? t("roomMap.objectPanel.hueLabel", { index: String(ch.channelIndex + 1) }),
      locked: ch.locked,
    });
  }

  return entries;
}

function ObjectRow({
  entry,
  selected,
  onSelect,
  onDelete,
  onRename,
  onToggleLock,
}: {
  entry: ObjectEntry;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename?: (label: string) => void;
  onToggleLock?: () => void;
}) {
  const { t } = useTranslation("common");
  const rowRef = useRef<HTMLLIElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    if (selected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);

  const handleDoubleClick = useCallback(() => {
    if (!onRename) return;
    setEditing(true);
    setEditValue(entry.label);
  }, [onRename, entry.label]);

  const handleCommit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== entry.label) {
      onRename?.(trimmed);
    }
    setEditing(false);
  }, [editValue, entry.label, onRename]);

  return (
    <li
      ref={rowRef}
      className={[
        "flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-[11px] group",
        selected
          ? "bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100"
          : "text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/50",
      ].join(" ")}
      onClick={onSelect}
    >
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${TYPE_COLORS[entry.type]}`} />
      {editing ? (
        <input
          autoFocus
          className="bg-transparent border-b border-slate-300 dark:border-zinc-600 text-[11px] focus:outline-none focus:border-cyan-400 flex-1 min-w-0"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleCommit(); }
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate" onDoubleClick={handleDoubleClick}>
          {entry.label}
        </span>
      )}
      {onToggleLock && (
        <button
          className="text-slate-400 dark:text-zinc-500 text-[11px] shrink-0 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded transition-opacity hover:text-slate-700 dark:hover:text-zinc-200"
          aria-label={entry.locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
          title={entry.locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
          onClick={(e) => { e.stopPropagation(); onToggleLock(); }}
        >
          {entry.locked ? (
            <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="8" height="6" rx="1" />
              <path d="M4 5V3a2 2 0 0 1 4 0v2" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="8" height="6" rx="1" />
              <path d="M4 5V3a2 2 0 0 1 4 0" />
            </svg>
          )}
        </button>
      )}
      {!entry.locked && (
        <button
          className="text-slate-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 text-[11px] shrink-0 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 rounded transition-opacity"
          aria-label={t("roomMap.objectPanel.delete")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          x
        </button>
      )}
    </li>
  );
}

function ZoneTab({
  zones,
  activeZoneId,
  onSelectZone,
  onAddZone,
  onDeleteZone,
  onRenameZone,
}: Pick<ObjectListPanelProps, "zones" | "activeZoneId" | "onSelectZone" | "onAddZone" | "onDeleteZone" | "onRenameZone">) {
  const { t } = useTranslation("common");
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  function handleStartEdit(zone: ZoneDefinition) {
    setEditingZoneId(zone.id);
    setEditValue(zone.name);
  }

  function handleCommitEdit(zone: ZoneDefinition, zoneIndex: number) {
    const name = editValue.trim() || t("roomMap.zones.defaultName", { N: String(zoneIndex + 1) });
    onRenameZone(zone.id, name);
    setEditingZoneId(null);
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {zones.length === 0 ? (
        <p className="text-[10px] text-slate-400 dark:text-zinc-500 py-3 text-center">
          {t("roomMap.zones.emptyPanel")}
        </p>
      ) : (
        <ul>
          {zones.map((zone, zoneIndex) => {
            const isActive = activeZoneId === zone.id;
            const isEditing = editingZoneId === zone.id;
            return (
              <li
                key={zone.id}
                className={[
                  "flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-[11px] group",
                  isActive
                    ? "bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100"
                    : "text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/50",
                ].join(" ")}
                onClick={() => onSelectZone(isActive ? null : zone.id)}
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${getZoneColor(zoneIndex)}`} />
                {isEditing ? (
                  <input
                    autoFocus
                    className="bg-transparent border-b border-slate-300 dark:border-zinc-600 text-[11px] focus:outline-none focus:border-cyan-400 flex-1 min-w-0"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleCommitEdit(zone, zoneIndex)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleCommitEdit(zone, zoneIndex); }
                      if (e.key === "Escape") setEditingZoneId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="flex-1 truncate"
                    onDoubleClick={(e) => { e.stopPropagation(); handleStartEdit(zone); }}
                  >
                    {zone.name}
                  </span>
                )}
                <span className="text-[9px] text-slate-400 dark:text-zinc-500 shrink-0">
                  {zone.channelIndices.length}
                </span>
                <button
                  className="text-slate-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 text-[11px] shrink-0 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity rounded"
                  onClick={(e) => { e.stopPropagation(); onDeleteZone(zone.id); }}
                >
                  x
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        className="mt-1 w-full text-[10px] text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200 py-1 transition-colors"
        onClick={onAddZone}
      >
        + {t("roomMap.zones.addZoneButton")}
      </button>
    </div>
  );
}

export function ObjectListPanel({
  config,
  selectedId,
  onSelect,
  onDelete,
  onRenameFurniture,
  onToggleLock,
  zones,
  activeZoneId,
  onSelectZone,
  onAddZone,
  onDeleteZone,
  onRenameZone,
}: ObjectListPanelProps) {
  const { t } = useTranslation("common");
  const [activeTab, setActiveTab] = useState<"objects" | "zones">("objects");
  const objects = buildObjectList(config, t);

  const tabBase = "flex-1 text-center py-1.5 text-[10px] font-semibold transition-colors cursor-pointer";
  const tabActive = "text-slate-900 dark:text-zinc-100 border-b-2 border-cyan-500";
  const tabInactive = "text-slate-500 dark:text-zinc-400 border-b border-slate-200 dark:border-zinc-700 hover:text-slate-700 dark:hover:text-zinc-200";

  return (
    <div className="flex flex-col h-full border-l border-slate-200/70 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 w-[180px] shrink-0">
      {/* Tab bar */}
      <div className="flex shrink-0">
        <button
          className={`${tabBase} ${activeTab === "objects" ? tabActive : tabInactive}`}
          onClick={() => setActiveTab("objects")}
        >
          {t("roomMap.objectPanel.objectsTab")}
        </button>
        <button
          className={`${tabBase} ${activeTab === "zones" ? tabActive : tabInactive}`}
          onClick={() => setActiveTab("zones")}
        >
          {t("roomMap.objectPanel.zonesTab")} {zones.length > 0 && `(${zones.length})`}
        </button>
      </div>

      {/* Content */}
      {activeTab === "objects" ? (
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {objects.length === 0 ? (
            <p className="text-[10px] text-slate-400 dark:text-zinc-500 py-3 text-center">
              {t("roomMap.objectPanel.empty")}
            </p>
          ) : (
            <ul>
              {objects.map((entry) => (
                <ObjectRow
                  key={entry.id}
                  entry={entry}
                  selected={selectedId === entry.id}
                  onSelect={() => onSelect(entry.id)}
                  onDelete={() => onDelete(entry.id)}
                  onRename={
                    entry.type === "furniture"
                      ? (label) => onRenameFurniture(entry.id.replace("furniture-", ""), label)
                      : undefined
                  }
                  onToggleLock={
                    onToggleLock
                      ? () => onToggleLock(entry.id)
                      : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <ZoneTab
          zones={zones}
          activeZoneId={activeZoneId}
          onSelectZone={onSelectZone}
          onAddZone={onAddZone}
          onDeleteZone={onDeleteZone}
          onRenameZone={onRenameZone}
        />
      )}
    </div>
  );
}
