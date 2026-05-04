import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type {
  HueZone,
  RoomMapConfig,
  ZoneDefinition,
} from "../../../../shared/contracts/roomMap";
import { getZoneColor } from "./ZoneListPanel";
import { HueZoneListPanel } from "./HueZoneListPanel";

type ObjectEntry = {
  id: string;
  type: "tv" | "furniture" | "usb" | "hue" | "image";
  label: string;
  locked?: boolean;
  /** v1.5 W1-A5: when present, the row renders nested under its parent zone group. */
  zoneId?: string;
};

interface ObjectListPanelProps {
  config: RoomMapConfig;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRenameFurniture: (id: string, label: string) => void;
  onToggleLock?: (id: string) => void;
  // Legacy USB-side zone props
  zones: ZoneDefinition[];
  activeZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onAddZone: () => void;
  onDeleteZone: (zoneId: string) => void;
  onRenameZone: (zoneId: string, name: string) => void;
  // v1.5 W1-A5 — Hue zone props (consume `config.hueZones`)
  hueZones?: HueZone[];
  activeHueZoneId?: string | null;
  onSelectHueZone?: (zoneId: string | null) => void;
  onAddHueZone?: () => void;
  onDeleteHueZone?: (zoneId: string) => void;
  onRenameHueZone?: (zoneId: string, name: string) => void;
  /** When true, the "+ Hue zone" CTA stays disabled (no entertainment area paired). */
  addHueZoneDisabled?: boolean;
  /** Tooltip on the disabled CTA. */
  addHueZoneDisabledTooltip?: string;
}

// Per-object identity swatch colors (5-10 px dots, not chrome). These are
// domain markers, not surface tokens, so the palette utilities stay.
const TYPE_COLORS: Record<ObjectEntry["type"], string> = {
  tv: "bg-violet-500",
  furniture: "bg-amber-500",
  usb: "bg-cyan-500",
  hue: "bg-white border border-zinc-400",
  image: "bg-zinc-800",
};

function buildObjectList(
  config: RoomMapConfig,
  t: (key: string, opts?: Record<string, string>) => string,
): ObjectEntry[] {
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
      zoneId: ch.zoneId,
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
  indented = false,
}: {
  entry: ObjectEntry;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename?: (label: string) => void;
  onToggleLock?: () => void;
  /** v1.5 W1-A5 — when nested under a zone header, indent and shrink. */
  indented?: boolean;
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
        "flex items-center gap-1.5 cursor-pointer rounded text-[11px] group",
        indented ? "px-1.5 py-0.5" : "px-2 py-1",
        selected
          ? "bg-[var(--lm-panel-2)] text-[var(--lm-ink)]"
          : "text-[var(--lm-ink-dim)] hover:bg-[var(--lm-panel-2)]/50",
      ].join(" ")}
      onClick={onSelect}
    >
      <span
        className={[
          "rounded-full shrink-0",
          indented ? "w-1.5 h-1.5" : "w-2.5 h-2.5",
          TYPE_COLORS[entry.type],
        ].join(" ")}
      />
      {editing ? (
        <input
          autoFocus
          className="bg-transparent border-b border-[var(--lm-line-2)] text-[11px] focus:outline-none focus:border-[var(--lm-amber)] flex-1 min-w-0"
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
          className="min-h-8 min-w-8 flex items-center justify-center text-[var(--lm-ink-faint)] text-[11px] shrink-0 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60 rounded transition-opacity hover:text-[var(--lm-ink)]"
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
          className="min-h-8 min-w-8 flex items-center justify-center text-[var(--lm-ink-faint)] text-[11px] shrink-0 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60 rounded transition-opacity hover:text-[var(--lm-red)]"
          aria-label={t("roomMap.objectPanel.delete")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
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
        <p className="text-[10px] text-[var(--lm-ink-faint)] py-3 text-center">
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
                    ? "bg-[var(--lm-panel-2)] text-[var(--lm-ink)]"
                    : "text-[var(--lm-ink-dim)] hover:bg-[var(--lm-panel-2)]/50",
                ].join(" ")}
                onClick={() => onSelectZone(isActive ? null : zone.id)}
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${getZoneColor(zoneIndex)}`} />
                {isEditing ? (
                  <input
                    autoFocus
                    className="bg-transparent border-b border-[var(--lm-line-2)] text-[11px] focus:outline-none focus:border-[var(--lm-amber)] flex-1 min-w-0"
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
                <span className="text-[9px] text-[var(--lm-ink-faint)] shrink-0">
                  {zone.channelIndices.length}
                </span>
                <button
                  className="min-h-8 min-w-8 flex items-center justify-center text-[var(--lm-ink-faint)] hover:text-[var(--lm-red)] text-[11px] shrink-0 leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60 transition-opacity rounded"
                  aria-label={t("roomMap.objectPanel.delete")}
                  onClick={(e) => { e.stopPropagation(); onDeleteZone(zone.id); }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        className="mt-1 w-full min-h-8 flex items-center justify-center text-[10px] text-[var(--lm-ink-dim)] hover:text-[var(--lm-ink)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60 rounded"
        onClick={onAddZone}
      >
        + {t("roomMap.zones.addZoneButton")}
      </button>
    </div>
  );
}

/**
 * v1.5 W1-A5 — render the Objects tab, but nest each Hue channel under its
 * parent `HueZone` header (or under "Unassigned" when `zoneId` is absent).
 * Non-Hue entries keep the legacy flat order so we don't disrupt USB / TV /
 * furniture / image rows that have no zone semantics.
 */
function renderObjectsWithHueGrouping(
  objects: ObjectEntry[],
  hueZones: HueZone[],
  selectedId: string | null,
  onSelect: (id: string | null) => void,
  onDelete: (id: string) => void,
  onRenameFurniture: (id: string, label: string) => void,
  onToggleLock: ((id: string) => void) | undefined,
  t: (key: string, opts?: Record<string, string>) => string,
): React.ReactNode {
  const nonHue = objects.filter((o) => o.type !== "hue");
  const hueObjects = objects.filter((o) => o.type === "hue");

  // Bucket Hue rows by zone id; preserve legacy flat order when no zones exist.
  const buckets = new Map<string, ObjectEntry[]>();
  const unassigned: ObjectEntry[] = [];
  for (const ho of hueObjects) {
    if (ho.zoneId && hueZones.some((z) => z.id === ho.zoneId)) {
      const bucket = buckets.get(ho.zoneId) ?? [];
      bucket.push(ho);
      buckets.set(ho.zoneId, bucket);
    } else {
      unassigned.push(ho);
    }
  }

  return (
    <ul>
      {nonHue.map((entry) => (
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
          onToggleLock={onToggleLock ? () => onToggleLock(entry.id) : undefined}
        />
      ))}

      {/* Hue zones grouped */}
      {hueZones.length > 0 &&
        hueZones.map((zone) => {
          const zoneRows = buckets.get(zone.id) ?? [];
          return (
            <li key={`zone-group-${zone.id}`} className="mt-1.5">
              <div
                className="flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--lm-ink-faint)]"
                role="heading"
                aria-level={3}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: zone.borderColor ?? "var(--lm-zone-1)" }}
                  aria-hidden
                />
                <span className="flex-1 truncate">{zone.name}</span>
                <span className="text-[9px] text-[var(--lm-ink-faint)]">{zoneRows.length}</span>
              </div>
              <ul className="ml-2 border-l border-[var(--lm-line)]/60 pl-1">
                {zoneRows.length === 0 ? (
                  <li className="px-1.5 py-0.5 text-[9px] italic text-[var(--lm-ink-faint)]">
                    {t("roomMap.hueZones.groupEmpty")}
                  </li>
                ) : (
                  zoneRows.map((entry) => (
                    <ObjectRow
                      key={entry.id}
                      entry={entry}
                      selected={selectedId === entry.id}
                      onSelect={() => onSelect(entry.id)}
                      onDelete={() => onDelete(entry.id)}
                      onToggleLock={onToggleLock ? () => onToggleLock(entry.id) : undefined}
                      indented
                    />
                  ))
                )}
              </ul>
            </li>
          );
        })}

      {/* Unassigned hue channels */}
      {hueObjects.length > 0 && unassigned.length > 0 && (
        <li className="mt-1.5">
          <div
            className="flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--lm-ink-faint)]"
            role="heading"
            aria-level={3}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lm-ink-faint)]" aria-hidden />
            <span className="flex-1 truncate">{t("roomMap.hueZones.unassignedTitle")}</span>
            <span className="text-[9px] text-[var(--lm-ink-faint)]">{unassigned.length}</span>
          </div>
          <ul className="ml-2 border-l border-[var(--lm-line)]/60 pl-1">
            {unassigned.map((entry) => (
              <ObjectRow
                key={entry.id}
                entry={entry}
                selected={selectedId === entry.id}
                onSelect={() => onSelect(entry.id)}
                onDelete={() => onDelete(entry.id)}
                onToggleLock={onToggleLock ? () => onToggleLock(entry.id) : undefined}
                indented
              />
            ))}
          </ul>
        </li>
      )}
    </ul>
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
  hueZones = [],
  activeHueZoneId = null,
  onSelectHueZone,
  onAddHueZone,
  onDeleteHueZone,
  onRenameHueZone,
  addHueZoneDisabled = false,
  addHueZoneDisabledTooltip,
}: ObjectListPanelProps) {
  const { t } = useTranslation("common");
  const [activeTab, setActiveTab] = useState<"objects" | "zones" | "hueZones">("objects");
  const objects = buildObjectList(config, t);
  const hueZoneEditingEnabled =
    onSelectHueZone !== undefined &&
    onAddHueZone !== undefined &&
    onDeleteHueZone !== undefined &&
    onRenameHueZone !== undefined;

  const tabBase = "flex-1 text-center py-1.5 text-[10px] font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60";
  const tabActive = "text-[var(--lm-ink)] border-b-2 border-[var(--lm-amber)]";
  const tabInactive = "text-[var(--lm-ink-dim)] border-b border-[var(--lm-line)] hover:text-[var(--lm-ink)]";

  return (
    <div className="flex flex-col h-full border-l border-[var(--lm-line)] bg-[var(--lm-panel)]/90 w-[180px] shrink-0">
      {/* Tab bar */}
      <div className="flex shrink-0">
        <button
          type="button"
          className={`${tabBase} ${activeTab === "objects" ? tabActive : tabInactive}`}
          onClick={() => setActiveTab("objects")}
        >
          {t("roomMap.objectPanel.objectsTab")}
        </button>
        <button
          type="button"
          className={`${tabBase} ${activeTab === "zones" ? tabActive : tabInactive}`}
          onClick={() => setActiveTab("zones")}
        >
          {t("roomMap.objectPanel.zonesTab")} {zones.length > 0 && `(${zones.length})`}
        </button>
        {hueZoneEditingEnabled && (
          <button
            type="button"
            className={`${tabBase} ${activeTab === "hueZones" ? tabActive : tabInactive}`}
            onClick={() => setActiveTab("hueZones")}
          >
            {t("roomMap.objectPanel.hueZonesTab")} {hueZones.length > 0 && `(${hueZones.length})`}
          </button>
        )}
      </div>

      {/* Content */}
      {activeTab === "objects" ? (
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {objects.length === 0 ? (
            <p className="text-[10px] text-[var(--lm-ink-faint)] py-3 text-center">
              {t("roomMap.objectPanel.empty")}
            </p>
          ) : (
            renderObjectsWithHueGrouping(
              objects,
              hueZones,
              selectedId,
              onSelect,
              onDelete,
              onRenameFurniture,
              onToggleLock,
              t,
            )
          )}
        </div>
      ) : activeTab === "zones" ? (
        <ZoneTab
          zones={zones}
          activeZoneId={activeZoneId}
          onSelectZone={onSelectZone}
          onAddZone={onAddZone}
          onDeleteZone={onDeleteZone}
          onRenameZone={onRenameZone}
        />
      ) : hueZoneEditingEnabled ? (
        <HueZoneListPanel
          zones={hueZones}
          channels={config.hueChannels}
          activeZoneId={activeHueZoneId}
          onSelectZone={onSelectHueZone!}
          onAddZone={onAddHueZone!}
          onDeleteZone={onDeleteHueZone!}
          onRenameZone={onRenameHueZone!}
          onSelectChannel={(idx) => onSelect(`hue-${idx}`)}
          addZoneDisabled={addHueZoneDisabled}
          addZoneDisabledTooltip={addHueZoneDisabledTooltip}
        />
      ) : null}
    </div>
  );
}
