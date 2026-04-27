/**
 * RoomDockPanel — v1.5 right-dock rework (replaces the legacy
 * `ObjectListPanel` + side-by-side `HueZonePropertiesPanel` layout).
 *
 * Why a single dock?
 * - The previous implementation stacked two 180px columns side by side
 *   when a Hue zone was active (`RoomMapEditor.tsx:1167-1174`); on
 *   narrow windows the second column overflowed past the canvas and
 *   broke the layout.
 * - Three peer panels (`ObjectListPanel`, `HueZoneListPanel`,
 *   `HueZonePropertiesPanel`) used inconsistent zinc-* tokens and lived
 *   at three different DOM positions, so the editor read as
 *   "two apps in one window" against the rest of amber Rev 07.
 *
 * Architecture:
 * - Single 240-280px dock, tabbed (Objects / Zones / Hue Zones).
 * - Split body: list (top, scrollable, flex 1) + inspector (bottom,
 *   capped at 50% height, type-aware).
 * - The inspector reads the **active selection** (selected object OR
 *   active zone OR active Hue zone) and renders the matching control:
 *     - Object selected ⇒ position/size/rotation summary + lock toggle
 *     - HueZone active  ⇒ color picker + scaleX/scaleY sliders
 *     - Legacy zone     ⇒ name + channel count summary
 *     - Nothing         ⇒ hint copy ("Select an object or zone…")
 *
 * Behaviour preserved:
 * - All existing CRUD callbacks have the same signatures
 *   (`RoomMapEditor` is unaware of the inner refactor).
 * - Tab IDs and active-tab state stay local; consumers can ignore them.
 * - The 3-panel grouping logic (Hue channels nested under their zone,
 *   "Unassigned" pseudo-bucket) is reproduced 1:1.
 *
 * A11y:
 * - Tab buttons + chips clear the 32px tap floor (`lm-room-dock-tab`).
 * - All actions go through `:focus-visible` + amber soft ring.
 * - Color is paired with text in the inspector chip (never the sole
 *   status signal).
 * - Reduced-motion and forced-colors branches in `styles.css`.
 */
import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import type {
  HueChannelPlacement,
  HueZone,
  RoomMapConfig,
  ZoneDefinition,
} from "../../../../shared/contracts/roomMap";
import { HueZoneInspector } from "./HueZoneInspector";

type DockTab = "objects" | "zones" | "hueZones" | "properties";

interface RoomDockPanelProps {
  config: RoomMapConfig;

  // Object selection (any draggable item on the canvas)
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRenameFurniture: (id: string, label: string) => void;
  onToggleLock: (id: string) => void;

  // Legacy USB-side zones
  zones: ZoneDefinition[];
  activeZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onAddZone: () => void;
  onDeleteZone: (zoneId: string) => void;
  onRenameZone: (zoneId: string, name: string) => void;

  // Hue zones (v1.5)
  hueZones?: HueZone[];
  activeHueZoneId?: string | null;
  onSelectHueZone?: (zoneId: string | null) => void;
  onAddHueZone?: () => void;
  onDeleteHueZone?: (zoneId: string) => void;
  onRenameHueZone?: (zoneId: string, name: string) => void;
  onUpdateHueZone?: (zoneId: string, patch: Partial<HueZone>) => void;
  /** When true, "+ Hue zone" CTA is disabled (no entertainment area paired). */
  addHueZoneDisabled?: boolean;
  addHueZoneDisabledTooltip?: string;
  // ── Wave 4-B props ────────────────────────────────────────────────
  /** True when a Hue bridge is paired (legacy plaintext or keychain). */
  hueBridgeConfigured?: boolean;
  /** Persisted entertainment area id; null when no area picked. */
  hueAreaId?: string | null;
  /**
   * B2/B3 — move a single channel between zones (or detach when target is
   * `null`). Powers the row drag handle, "Unassigned" drop bucket, and the
   * inline "Move to →" popover. Inert when omitted, so the dock degrades
   * to the v1.5 read-only flow.
   */
  onAssignChannelToZone?: (channelIndex: number, targetZoneId: string | null) => void;
  /**
   * B1 — emitted when the state strip CTA prompts the user to finish Hue
   * onboarding. Inert when omitted (CTA still renders for clarity but
   * does nothing on click).
   */
  onNavigateToDevices?: () => void;
}

/* ── helpers ─────────────────────────────────────────────────────── */

interface ObjectRowEntry {
  id: string;
  type: "tv" | "furniture" | "usb" | "hue" | "image";
  label: string;
  locked?: boolean;
  zoneId?: string;
}

const ZONE_TOKENS = [
  "var(--lm-zone-1)",
  "var(--lm-zone-2)",
  "var(--lm-zone-3)",
  "var(--lm-zone-4)",
  "var(--lm-zone-5)",
  "var(--lm-zone-6)",
];

const TYPE_DOT_COLOR: Record<ObjectRowEntry["type"], string> = {
  tv: "var(--lm-zone-3)", // purple
  furniture: "var(--lm-amber)",
  usb: "var(--lm-zone-6)", // cyan
  hue: "var(--lm-ink-dim)",
  image: "var(--lm-ink-faint)",
};

function getZoneColor(zone: { borderColor?: string }, index: number): string {
  if (zone.borderColor) return zone.borderColor;
  return ZONE_TOKENS[index % ZONE_TOKENS.length];
}

function buildObjectList(
  config: RoomMapConfig,
  t: (key: string, opts?: Record<string, string>) => string,
): ObjectRowEntry[] {
  const rows: ObjectRowEntry[] = [];
  for (const layer of config.imageLayers) {
    rows.push({
      id: `img-${layer.id}`,
      type: "image",
      label: layer.label,
      locked: layer.locked,
    });
  }
  if (config.tvAnchor) {
    rows.push({
      id: "tv",
      type: "tv",
      label: t("roomMap.objectPanel.tvLabel"),
      locked: config.tvAnchor.locked,
    });
  }
  for (const f of config.furniture) {
    rows.push({
      id: `furniture-${f.id}`,
      type: "furniture",
      label: f.label ?? t(`roomMap.furniture.type.${f.type}`),
      locked: f.locked,
    });
  }
  for (const s of config.usbStrips) {
    rows.push({
      id: `usb-${s.stripId}`,
      type: "usb",
      label: t("roomMap.objectPanel.ledLabel", { count: String(s.ledCount) }),
      locked: s.locked,
    });
  }
  for (const ch of config.hueChannels) {
    rows.push({
      id: `hue-${ch.channelIndex}`,
      type: "hue",
      label: ch.label ?? t("roomMap.objectPanel.hueLabel", { index: String(ch.channelIndex + 1) }),
      locked: ch.locked,
      zoneId: ch.zoneId,
    });
  }
  return rows;
}

/* ── inline icons ───────────────────────────────────────────────── */

function IconLockClosed() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="7" height="5.5" rx="1" />
      <path d="M4 5V3.5a2 2 0 0 1 4 0V5" />
    </svg>
  );
}
function IconLockOpen() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="7" height="5.5" rx="1" />
      <path d="M4 5V3.5a2 2 0 0 1 4 0" />
    </svg>
  );
}

/* ── object row ─────────────────────────────────────────────────── */

function ObjectRow({
  entry,
  selected,
  nested,
  dotColor,
  onSelect,
  onDelete,
  onRename,
  onToggleLock,
}: {
  entry: ObjectRowEntry;
  selected: boolean;
  nested?: boolean;
  dotColor: string;
  onSelect: () => void;
  onDelete: () => void;
  onRename?: (label: string) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation("common");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const startEdit = useCallback(() => {
    if (!onRename) return;
    setEditing(true);
    setEditValue(entry.label);
  }, [onRename, entry.label]);

  const commit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== entry.label) onRename?.(trimmed);
    setEditing(false);
  }, [editValue, entry.label, onRename]);

  return (
    <li
      className={["lm-room-dock-row", selected ? "is-on" : "", nested ? "is-nested" : ""]
        .filter(Boolean)
        .join(" ")}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="lm-room-dock-row-dot" style={{ background: dotColor }} aria-hidden />
      {editing ? (
        <input
          autoFocus
          className="lm-room-dock-row-edit"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="lm-room-dock-row-label"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          {entry.label}
        </span>
      )}
      <button
        type="button"
        className="lm-room-dock-row-action"
        aria-label={entry.locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
        title={entry.locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLock();
        }}
      >
        {entry.locked ? <IconLockClosed /> : <IconLockOpen />}
      </button>
      {!entry.locked && (
        <button
          type="button"
          className="lm-room-dock-row-action is-danger"
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

/* ── tabs ────────────────────────────────────────────────────────── */

function ObjectsTab(props: {
  config: RoomMapConfig;
  selectedId: string | null;
  hueZones: HueZone[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRenameFurniture: (id: string, label: string) => void;
  onToggleLock: (id: string) => void;
}) {
  const { config, selectedId, hueZones, onSelect, onDelete, onRenameFurniture, onToggleLock } = props;
  const { t } = useTranslation("common");
  const rows = buildObjectList(config, t);
  if (rows.length === 0) {
    return <div className="lm-room-dock-empty">{t("roomMap.objectPanel.empty")}</div>;
  }
  const nonHue = rows.filter((r) => r.type !== "hue");
  const hueRows = rows.filter((r) => r.type === "hue");
  const hueByZone = new Map<string, ObjectRowEntry[]>();
  const unassigned: ObjectRowEntry[] = [];
  for (const r of hueRows) {
    if (r.zoneId && hueZones.some((z) => z.id === r.zoneId)) {
      const bucket = hueByZone.get(r.zoneId) ?? [];
      bucket.push(r);
      hueByZone.set(r.zoneId, bucket);
    } else {
      unassigned.push(r);
    }
  }

  return (
    <ul className="space-y-px">
      {nonHue.map((entry) => (
        <ObjectRow
          key={entry.id}
          entry={entry}
          selected={selectedId === entry.id}
          dotColor={TYPE_DOT_COLOR[entry.type]}
          onSelect={() => onSelect(entry.id)}
          onDelete={() => onDelete(entry.id)}
          onRename={
            entry.type === "furniture"
              ? (label) => onRenameFurniture(entry.id.replace("furniture-", ""), label)
              : undefined
          }
          onToggleLock={() => onToggleLock(entry.id)}
        />
      ))}

      {hueZones.map((zone, zi) => {
        const bucket = hueByZone.get(zone.id) ?? [];
        const color = getZoneColor(zone, zi);
        return (
          <li key={`zone-${zone.id}`}>
            <div className="lm-room-dock-h" role="heading" aria-level={3}>
              <span className="lm-room-dock-h-dot" style={{ background: color }} aria-hidden />
              <span className="lm-room-dock-h-name">{zone.name}</span>
              <span className="lm-room-dock-h-count">{bucket.length}</span>
            </div>
            {bucket.length === 0 ? (
              <div className="lm-room-dock-empty" style={{ padding: "4px 8px", textAlign: "left" }}>
                {t("roomMap.hueZones.groupEmpty")}
              </div>
            ) : (
              <ul className="space-y-px">
                {bucket.map((entry) => (
                  <ObjectRow
                    key={entry.id}
                    entry={entry}
                    selected={selectedId === entry.id}
                    nested
                    dotColor={color}
                    onSelect={() => onSelect(entry.id)}
                    onDelete={() => onDelete(entry.id)}
                    onToggleLock={() => onToggleLock(entry.id)}
                  />
                ))}
              </ul>
            )}
          </li>
        );
      })}

      {unassigned.length > 0 && (
        <li>
          <div className="lm-room-dock-h" role="heading" aria-level={3}>
            <span
              className="lm-room-dock-h-dot"
              style={{ background: "var(--lm-ink-faint)" }}
              aria-hidden
            />
            <span className="lm-room-dock-h-name">{t("roomMap.hueZones.unassignedTitle")}</span>
            <span className="lm-room-dock-h-count">{unassigned.length}</span>
          </div>
          <ul className="space-y-px">
            {unassigned.map((entry) => (
              <ObjectRow
                key={entry.id}
                entry={entry}
                selected={selectedId === entry.id}
                nested
                dotColor={TYPE_DOT_COLOR.hue}
                onSelect={() => onSelect(entry.id)}
                onDelete={() => onDelete(entry.id)}
                onToggleLock={() => onToggleLock(entry.id)}
              />
            ))}
          </ul>
        </li>
      )}
    </ul>
  );
}

function ZonesTab(props: {
  zones: ZoneDefinition[];
  activeZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  onAddZone: () => void;
  onDeleteZone: (id: string) => void;
  onRenameZone: (id: string, name: string) => void;
}) {
  const { zones, activeZoneId, onSelectZone, onAddZone, onDeleteZone, onRenameZone } = props;
  const { t } = useTranslation("common");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  return (
    <>
      <div className="lm-room-dock-h">
        <span className="lm-room-dock-h-name">{t("roomMap.zones.panelTitle")}</span>
        <button
          type="button"
          className="lm-room-dock-h-add"
          onClick={onAddZone}
        >
          {t("roomMap.zones.addZoneButton")}
        </button>
      </div>
      {zones.length === 0 ? (
        <div className="lm-room-dock-empty">{t("roomMap.zones.emptyPanel")}</div>
      ) : (
        <ul className="space-y-px">
          {zones.map((zone, zi) => {
            const isActive = activeZoneId === zone.id;
            const isEditing = editingId === zone.id;
            return (
              <li
                key={zone.id}
                className={`lm-room-dock-row ${isActive ? "is-on" : ""}`}
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
                <span
                  className="lm-room-dock-row-dot"
                  style={{ background: ZONE_TOKENS[zi % ZONE_TOKENS.length] }}
                  aria-hidden
                />
                {isEditing ? (
                  <input
                    autoFocus
                    className="lm-room-dock-row-edit"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => {
                      const name =
                        editValue.trim() ||
                        t("roomMap.zones.defaultName", { N: String(zi + 1) });
                      onRenameZone(zone.id, name);
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const name =
                          editValue.trim() ||
                          t("roomMap.zones.defaultName", { N: String(zi + 1) });
                        onRenameZone(zone.id, name);
                        setEditingId(null);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="lm-room-dock-row-label"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingId(zone.id);
                      setEditValue(zone.name);
                    }}
                  >
                    {zone.name}
                  </span>
                )}
                <span className="lm-room-dock-row-meta">{zone.channelIndices.length}</span>
                <button
                  type="button"
                  className="lm-room-dock-row-action is-danger"
                  aria-label={t("roomMap.zones.deleteAriaLabel", { name: zone.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteZone(zone.id);
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

interface HueAreaState {
  kind: "not-configured" | "no-area" | "ready";
  /** True when an entertainment area id is persisted but no bridge cred is on file. */
  orphanedAreaId: boolean;
}

function deriveHueAreaState(
  hueBridgeConfigured: boolean,
  hueAreaId: string | null | undefined,
): HueAreaState {
  if (!hueBridgeConfigured) {
    return {
      kind: "not-configured",
      // Surface the "you have an old area id but no bridge to talk to"
      // case so the strip can show a slightly different copy and a
      // clear "re-pair" CTA. The persisted area id is kept (we do NOT
      // clear it here) — the user may simply be offline, and dropping
      // the id would force them to re-pick after every disconnect.
      orphanedAreaId: !!hueAreaId,
    };
  }
  if (!hueAreaId) {
    return { kind: "no-area", orphanedAreaId: false };
  }
  return { kind: "ready", orphanedAreaId: false };
}

/**
 * Inline "Move to → <zone>" popover anchored to a channel row's move
 * button. Renders fixed-positioned next to the trigger so it can never
 * be clipped by the dock's vertical scroll. Closes on outside click,
 * Escape, or zone pick — keeps focus management trap-free.
 */
function MovePopover({
  zones,
  currentZoneId,
  onPick,
  onClose,
  triggerRect,
}: {
  zones: HueZone[];
  currentZoneId: string | null;
  onPick: (zoneId: string | null) => void;
  onClose: () => void;
  triggerRect: DOMRect | null;
}) {
  const { t } = useTranslation("common");
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-move-popover]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!triggerRect) return null;
  const top = Math.max(8, triggerRect.bottom + 4);
  const left = Math.max(8, triggerRect.right - 200);

  return (
    <div
      data-move-popover
      role="menu"
      aria-label={t("roomMap.hueZones.movePopoverLabel")}
      className="lm-room-dock-move-popover"
      style={{ position: "fixed", top, left }}
    >
      <button
        type="button"
        role="menuitem"
        className={`lm-room-dock-move-item ${currentZoneId === null ? "is-on" : ""}`}
        onClick={() => {
          onPick(null);
          onClose();
        }}
      >
        <span
          className="lm-room-dock-move-item-dot"
          style={{ background: "var(--lm-ink-faint)" }}
          aria-hidden
        />
        <span>{t("roomMap.hueZones.unassignedTitle")}</span>
      </button>
      {zones.map((z, zi) => (
        <button
          key={z.id}
          type="button"
          role="menuitem"
          className={`lm-room-dock-move-item ${currentZoneId === z.id ? "is-on" : ""}`}
          onClick={() => {
            onPick(z.id);
            onClose();
          }}
        >
          <span
            className="lm-room-dock-move-item-dot"
            style={{ background: getZoneColor(z, zi) }}
            aria-hidden
          />
          <span>{z.name}</span>
        </button>
      ))}
    </div>
  );
}

function IconDragHandle() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="3" r="0.9" />
      <circle cx="3.5" cy="6" r="0.9" />
      <circle cx="3.5" cy="9" r="0.9" />
      <circle cx="8.5" cy="3" r="0.9" />
      <circle cx="8.5" cy="6" r="0.9" />
      <circle cx="8.5" cy="9" r="0.9" />
    </svg>
  );
}

function IconMoveTo() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 6h7" />
      <path d="M6 3l3 3-3 3" />
    </svg>
  );
}

function HueZonesTab(props: {
  hueZones: HueZone[];
  channels: HueChannelPlacement[];
  activeHueZoneId: string | null;
  onSelectHueZone: (id: string | null) => void;
  onAddHueZone: () => void;
  onDeleteHueZone: (id: string) => void;
  onRenameHueZone: (id: string, name: string) => void;
  addHueZoneDisabled: boolean;
  addHueZoneDisabledTooltip?: string;
  onSelectChannel: (idx: number) => void;
  hueBridgeConfigured: boolean;
  hueAreaId: string | null;
  onAssignChannelToZone?: (channelIndex: number, targetZoneId: string | null) => void;
  onNavigateToDevices?: () => void;
}) {
  const {
    hueZones,
    channels,
    activeHueZoneId,
    onSelectHueZone,
    onAddHueZone,
    onDeleteHueZone,
    onRenameHueZone,
    addHueZoneDisabled,
    addHueZoneDisabledTooltip,
    onSelectChannel,
    hueBridgeConfigured,
    hueAreaId,
    onAssignChannelToZone,
    onNavigateToDevices,
  } = props;
  const { t } = useTranslation("common");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // ── Wave 4-B (B1) — area-state header ─────────────────────────────
  const areaState = deriveHueAreaState(hueBridgeConfigured, hueAreaId);

  // ── Wave 4-B (B2/B3) — drag-and-drop + move popover state ─────────
  const [dragChannelIndex, setDragChannelIndex] = useState<number | null>(null);
  const [dropTargetZoneId, setDropTargetZoneId] = useState<string | null | undefined>(undefined);
  const [movePopover, setMovePopover] = useState<{
    channelIndex: number;
    triggerRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    if (dragChannelIndex !== null && !channels.some((c) => c.channelIndex === dragChannelIndex)) {
      setDragChannelIndex(null);
      setDropTargetZoneId(undefined);
    }
  }, [channels, dragChannelIndex]);

  const byZone = new Map<string, HueChannelPlacement[]>();
  const unassigned: HueChannelPlacement[] = [];
  for (const ch of channels) {
    if (ch.zoneId && hueZones.some((z) => z.id === ch.zoneId)) {
      const bucket = byZone.get(ch.zoneId) ?? [];
      bucket.push(ch);
      byZone.set(ch.zoneId, bucket);
    } else {
      unassigned.push(ch);
    }
  }

  const dragSupported = !!onAssignChannelToZone;

  const channelDragProps = (ch: HueChannelPlacement) => {
    if (!dragSupported) return {} as Record<string, never>;
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent<HTMLLIElement>) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-lumasync-channel", String(ch.channelIndex));
        setDragChannelIndex(ch.channelIndex);
      },
      onDragEnd: () => {
        setDragChannelIndex(null);
        setDropTargetZoneId(undefined);
      },
    } as const;
  };

  const dropTargetProps = (targetZoneId: string | null) => {
    if (!dragSupported) return {} as Record<string, never>;
    return {
      onDragOver: (e: React.DragEvent) => {
        if (dragChannelIndex === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dropTargetZoneId !== targetZoneId) setDropTargetZoneId(targetZoneId);
      },
      onDragLeave: () => {
        if (dropTargetZoneId === targetZoneId) setDropTargetZoneId(undefined);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData("application/x-lumasync-channel");
        const idx = raw ? parseInt(raw, 10) : dragChannelIndex;
        if (idx === null || Number.isNaN(idx)) return;
        onAssignChannelToZone?.(idx, targetZoneId);
        setDragChannelIndex(null);
        setDropTargetZoneId(undefined);
      },
    } as const;
  };

  return (
    <>
      {/* B1 — Hue area state strip; renders above the Title row so the
          user always knows whether the dock is operational without
          cross-referencing the Devices section. */}
      <div
        className={`lm-room-dock-area-state lm-room-dock-area-state--${areaState.kind}`}
        role="status"
        aria-live="polite"
      >
        <span className="lm-room-dock-area-state-dot" aria-hidden />
        <div className="lm-room-dock-area-state-text">
          <span className="lm-room-dock-area-state-title">
            {areaState.kind === "not-configured"
              ? areaState.orphanedAreaId
                ? t("roomMap.hueZones.areaState.offlineTitle")
                : t("roomMap.hueZones.areaState.notConfiguredTitle")
              : areaState.kind === "no-area"
                ? t("roomMap.hueZones.areaState.noAreaTitle")
                : t("roomMap.hueZones.areaState.readyTitle", {
                    N: String(hueZones.length),
                  })}
          </span>
          <span className="lm-room-dock-area-state-sub">
            {areaState.kind === "not-configured"
              ? areaState.orphanedAreaId
                ? t("roomMap.hueZones.areaState.offlineHint")
                : t("roomMap.hueZones.areaState.notConfiguredHint")
              : areaState.kind === "no-area"
                ? t("roomMap.hueZones.areaState.noAreaHint")
                : t("roomMap.hueZones.areaState.readyHint")}
          </span>
        </div>
        {areaState.kind !== "ready" && onNavigateToDevices && (
          <button
            type="button"
            className="lm-room-dock-area-state-cta"
            onClick={onNavigateToDevices}
          >
            {areaState.kind === "not-configured"
              ? t("roomMap.hueZones.areaState.notConfiguredCta")
              : t("roomMap.hueZones.areaState.noAreaCta")}
          </button>
        )}
      </div>

      <div className="lm-room-dock-h">
        <span className="lm-room-dock-h-name">{t("roomMap.hueZones.title")}</span>
        <button
          type="button"
          className="lm-room-dock-h-add"
          onClick={addHueZoneDisabled ? undefined : onAddHueZone}
          disabled={addHueZoneDisabled}
          aria-disabled={addHueZoneDisabled}
          title={addHueZoneDisabled ? addHueZoneDisabledTooltip : undefined}
        >
          {t("roomMap.hueZones.addAction")}
        </button>
      </div>

      {hueZones.length === 0 ? (
        <div className="lm-room-dock-empty">
          <div>{t("roomMap.hueZones.empty")}</div>
          <button
            type="button"
            className="lm-room-dock-cta lm-room-dock-empty-cta"
            onClick={addHueZoneDisabled ? undefined : onAddHueZone}
            disabled={addHueZoneDisabled}
            aria-disabled={addHueZoneDisabled}
            title={addHueZoneDisabled ? addHueZoneDisabledTooltip : undefined}
          >
            {t("roomMap.hueZones.emptyCta")}
          </button>
        </div>
      ) : (
        <ul className="space-y-px">
          {hueZones.map((zone, zi) => {
            const isActive = activeHueZoneId === zone.id;
            const isEditing = editingId === zone.id;
            const color = getZoneColor(zone, zi);
            const bucket = byZone.get(zone.id) ?? [];
            const isDropTarget = dropTargetZoneId === zone.id && dragChannelIndex !== null;
            return (
              <li key={zone.id}>
                <div
                  className={[
                    "lm-room-dock-row",
                    isActive ? "is-on" : "",
                    isDropTarget ? "is-drop-target" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
                  data-drop-zone-id={zone.id}
                  onClick={() => onSelectHueZone(isActive ? null : zone.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectHueZone(isActive ? null : zone.id);
                    }
                  }}
                  {...dropTargetProps(zone.id)}
                >
                  <span
                    className="lm-room-dock-row-dot"
                    style={{ background: color }}
                    aria-hidden
                  />
                  {isEditing ? (
                    <input
                      autoFocus
                      className="lm-room-dock-row-edit"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => {
                        const fallback = t("roomMap.hueZones.defaultName", { N: String(zi + 1) });
                        const name = editValue.trim() || fallback;
                        onRenameHueZone(zone.id, name);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const fallback = t("roomMap.hueZones.defaultName", { N: String(zi + 1) });
                          const name = editValue.trim() || fallback;
                          onRenameHueZone(zone.id, name);
                          setEditingId(null);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="lm-room-dock-row-label"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(zone.id);
                        setEditValue(zone.name);
                      }}
                    >
                      {zone.name}
                    </span>
                  )}
                  <span className="lm-room-dock-row-meta">
                    {bucket.length === 1
                      ? t("roomMap.hueZones.lightCountOne")
                      : t("roomMap.hueZones.lightCount", { N: String(bucket.length) })}
                  </span>
                  <button
                    type="button"
                    className="lm-room-dock-row-action is-danger"
                    aria-label={t("roomMap.hueZones.deleteAriaLabel", { name: zone.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteHueZone(zone.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {bucket.length > 0 && (
                  <ul className="space-y-px">
                    {bucket.map((ch) => (
                      <li
                        key={ch.channelIndex}
                        className={[
                          "lm-room-dock-row",
                          "is-nested",
                          dragChannelIndex === ch.channelIndex ? "is-drag-source" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectChannel(ch.channelIndex);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectChannel(ch.channelIndex);
                          }
                        }}
                        {...channelDragProps(ch)}
                      >
                        {dragSupported && (
                          <span
                            className="lm-room-dock-row-grip"
                            aria-hidden
                            title={t("roomMap.hueZones.dragHandleTip")}
                          >
                            <IconDragHandle />
                          </span>
                        )}
                        <span
                          className="lm-room-dock-row-dot"
                          style={{ background: color, opacity: 0.7 }}
                          aria-hidden
                        />
                        <span className="lm-room-dock-row-label">
                          {ch.label ??
                            t("roomMap.hueChannel.defaultLabel", {
                              index: String(ch.channelIndex + 1),
                            })}
                        </span>
                        {dragSupported && (
                          <button
                            type="button"
                            className="lm-room-dock-row-action lm-room-dock-row-action--move"
                            aria-label={t("roomMap.hueZones.moveChannelAriaLabel", {
                              channel: String(ch.channelIndex + 1),
                            })}
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                              setMovePopover({ channelIndex: ch.channelIndex, triggerRect: rect });
                            }}
                          >
                            <IconMoveTo />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {(unassigned.length > 0 || dragSupported) && (
            <li>
              <div
                className={[
                  "lm-room-dock-h",
                  dropTargetZoneId === null && dragChannelIndex !== null ? "is-drop-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                role="heading"
                aria-level={3}
                data-drop-zone-id="__unassigned__"
                {...dropTargetProps(null)}
              >
                <span
                  className="lm-room-dock-h-dot"
                  style={{ background: "var(--lm-ink-faint)" }}
                  aria-hidden
                />
                <span className="lm-room-dock-h-name">
                  {t("roomMap.hueZones.unassignedTitle")}
                </span>
                <span className="lm-room-dock-h-count">{unassigned.length}</span>
              </div>
              {unassigned.length > 0 && (
                <ul className="space-y-px">
                  {unassigned.map((ch) => (
                    <li
                      key={ch.channelIndex}
                      className={[
                        "lm-room-dock-row",
                        "is-nested",
                        dragChannelIndex === ch.channelIndex ? "is-drag-source" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectChannel(ch.channelIndex)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectChannel(ch.channelIndex);
                        }
                      }}
                      {...channelDragProps(ch)}
                    >
                      {dragSupported && (
                        <span
                          className="lm-room-dock-row-grip"
                          aria-hidden
                          title={t("roomMap.hueZones.dragHandleTip")}
                        >
                          <IconDragHandle />
                        </span>
                      )}
                      <span
                        className="lm-room-dock-row-dot"
                        style={{ background: "var(--lm-ink-faint)", opacity: 0.7 }}
                        aria-hidden
                      />
                      <span className="lm-room-dock-row-label">
                        {ch.label ??
                          t("roomMap.hueChannel.defaultLabel", {
                            index: String(ch.channelIndex + 1),
                          })}
                      </span>
                      {dragSupported && hueZones.length > 0 && (
                        <button
                          type="button"
                          className="lm-room-dock-row-action lm-room-dock-row-action--move"
                          aria-label={t("roomMap.hueZones.moveChannelAriaLabel", {
                            channel: String(ch.channelIndex + 1),
                          })}
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                            setMovePopover({ channelIndex: ch.channelIndex, triggerRect: rect });
                          }}
                        >
                          <IconMoveTo />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}

      {movePopover && onAssignChannelToZone && (
        <MovePopover
          zones={hueZones}
          currentZoneId={
            channels.find((c) => c.channelIndex === movePopover.channelIndex)?.zoneId ?? null
          }
          triggerRect={movePopover.triggerRect}
          onPick={(zoneId) => onAssignChannelToZone(movePopover.channelIndex, zoneId)}
          onClose={() => setMovePopover(null)}
        />
      )}
    </>
  );
}

/* ── inspector ──────────────────────────────────────────────────── */

function ObjectInspector({ config, selectedId }: { config: RoomMapConfig; selectedId: string }) {
  const { t } = useTranslation("common");
  // Render type-aware summary so the inspector mirrors the property bar
  // without duplicating the editable fields (PropertyBar is the source
  // of truth for numeric edits — the inspector surfaces context).
  let label = "";
  let typeKey = "";
  let dotColor = TYPE_DOT_COLOR.image;
  if (selectedId === "tv" && config.tvAnchor) {
    label = t("roomMap.objectPanel.tvLabel");
    typeKey = t("roomMap.inspector.typeTv");
    dotColor = TYPE_DOT_COLOR.tv;
  } else if (selectedId.startsWith("furniture-")) {
    const f = config.furniture.find((it) => it.id === selectedId.replace("furniture-", ""));
    if (!f) return null;
    label = f.label ?? t(`roomMap.furniture.type.${f.type}`);
    typeKey = t("roomMap.inspector.typeFurniture");
    dotColor = TYPE_DOT_COLOR.furniture;
  } else if (selectedId.startsWith("usb-")) {
    const s = config.usbStrips.find((it) => it.stripId === selectedId.replace("usb-", ""));
    if (!s) return null;
    label = t("roomMap.objectPanel.ledLabel", { count: String(s.ledCount) });
    typeKey = t("roomMap.inspector.typeUsb");
    dotColor = TYPE_DOT_COLOR.usb;
  } else if (selectedId.startsWith("hue-")) {
    const idx = parseInt(selectedId.replace("hue-", ""), 10);
    const ch = config.hueChannels[idx];
    if (!ch) return null;
    label = ch.label ?? t("roomMap.objectPanel.hueLabel", { index: String(idx + 1) });
    typeKey = t("roomMap.inspector.typeHue");
    dotColor = TYPE_DOT_COLOR.hue;
  } else if (selectedId.startsWith("img-")) {
    const layer = config.imageLayers.find((l) => l.id === selectedId.replace("img-", ""));
    if (!layer) return null;
    label = layer.label;
    typeKey = t("roomMap.inspector.typeImage");
    dotColor = TYPE_DOT_COLOR.image;
  }

  return (
    <>
      <div className="lm-room-dock-inspect-h">
        <span className="lm-room-dock-inspect-h-chip">
          <span
            className="lm-room-dock-inspect-h-chip-dot"
            style={{ background: dotColor }}
            aria-hidden
          />
          <span>{typeKey}</span>
        </span>
        <span className="sub" title={label}>
          {label}
        </span>
      </div>
      <p className="lm-room-dock-inspect-empty">
        {t("roomMap.inspector.objectHint")}
      </p>
    </>
  );
}

/* ── main panel ─────────────────────────────────────────────────── */

export function RoomDockPanel(props: RoomDockPanelProps) {
  const {
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
    onUpdateHueZone,
    addHueZoneDisabled = false,
    addHueZoneDisabledTooltip,
    hueBridgeConfigured = false,
    hueAreaId = null,
    onAssignChannelToZone,
    onNavigateToDevices,
  } = props;
  const { t } = useTranslation("common");

  const hueZoneEditing =
    onSelectHueZone !== undefined &&
    onAddHueZone !== undefined &&
    onDeleteHueZone !== undefined &&
    onRenameHueZone !== undefined;

  const [activeTab, setActiveTab] = useState<DockTab>("objects");

  const activeHueZone = activeHueZoneId
    ? hueZones.find((z) => z.id === activeHueZoneId) ?? null
    : null;
  const activeLegacyZone = activeZoneId ? zones.find((z) => z.id === activeZoneId) ?? null : null;

  // Inspector pick: Hue zone wins (active zone > selected object > legacy zone)
  const inspectorMode: "hueZone" | "object" | "legacyZone" | "empty" = activeHueZone
    ? "hueZone"
    : selectedId
      ? "object"
      : activeLegacyZone
        ? "legacyZone"
        : "empty";

  const tabs: Array<{ id: DockTab; label: string; count?: number; visible: boolean }> = [
    { id: "objects", label: t("roomMap.objectPanel.objectsTab"), visible: true },
    { id: "zones", label: t("roomMap.objectPanel.zonesTab"), count: zones.length, visible: true },
    {
      id: "hueZones",
      label: t("roomMap.objectPanel.hueZonesTab"),
      count: hueZones.length,
      visible: hueZoneEditing,
    },
    {
      id: "properties",
      label: t("roomMap.objectPanel.propertiesTab"),
      visible: true,
    },
  ];

  const renderInspector = () => {
    if (inspectorMode === "hueZone" && activeHueZone) {
      return (
        <HueZoneInspector
          zone={activeHueZone}
          onUpdate={(patch) => onUpdateHueZone?.(activeHueZone.id, patch)}
        />
      );
    }
    if (inspectorMode === "object" && selectedId) {
      return <ObjectInspector config={config} selectedId={selectedId} />;
    }
    if (inspectorMode === "legacyZone" && activeLegacyZone) {
      return (
        <>
          <div className="lm-room-dock-inspect-h">
            <span>{t("roomMap.inspector.zoneTitle")}</span>
            <span className="sub" title={activeLegacyZone.name}>
              {activeLegacyZone.name}
            </span>
          </div>
          <div className="lm-room-dock-field">
            <span className="lm-room-dock-field-label">
              {t("roomMap.inspector.channelsLabel")}
            </span>
            <span className="lm-room-dock-field-value">
              {activeLegacyZone.channelIndices.length}
            </span>
          </div>
          <p className="lm-room-dock-inspect-empty">
            {t("roomMap.inspector.legacyZoneHint")}
          </p>
        </>
      );
    }
    return (
      <p className="lm-room-dock-inspect-empty">{t("roomMap.inspector.empty")}</p>
    );
  };

  return (
    <aside className="lm-room-dock" aria-label={t("roomMap.objectPanel.dockAriaLabel")}>
      <div className="lm-room-dock-tabs" role="tablist">
        {tabs
          .filter((tab) => tab.visible)
          .map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`lm-room-dock-tab ${activeTab === tab.id ? "is-on" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 && (
                <span className="lm-room-dock-tab-count">{tab.count}</span>
              )}
            </button>
          ))}
      </div>

      <div className="lm-room-dock-body">
        <div className="lm-room-dock-list" role="tabpanel">
          {activeTab === "objects" ? (
            <ObjectsTab
              config={config}
              hueZones={hueZones}
              selectedId={selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
              onRenameFurniture={onRenameFurniture}
              onToggleLock={onToggleLock}
            />
          ) : activeTab === "zones" ? (
            <ZonesTab
              zones={zones}
              activeZoneId={activeZoneId}
              onSelectZone={onSelectZone}
              onAddZone={onAddZone}
              onDeleteZone={onDeleteZone}
              onRenameZone={onRenameZone}
            />
          ) : activeTab === "hueZones" && hueZoneEditing ? (
            <HueZonesTab
              hueZones={hueZones}
              channels={config.hueChannels}
              activeHueZoneId={activeHueZoneId}
              onSelectHueZone={onSelectHueZone!}
              onAddHueZone={onAddHueZone!}
              onDeleteHueZone={onDeleteHueZone!}
              onRenameHueZone={onRenameHueZone!}
              addHueZoneDisabled={addHueZoneDisabled}
              addHueZoneDisabledTooltip={addHueZoneDisabledTooltip}
              onSelectChannel={(idx) => onSelect(`hue-${idx}`)}
              hueBridgeConfigured={hueBridgeConfigured}
              hueAreaId={hueAreaId}
              onAssignChannelToZone={onAssignChannelToZone}
              onNavigateToDevices={onNavigateToDevices}
            />
          ) : activeTab === "properties" ? (
            <div className="lm-room-dock-empty">{t("roomMap.inspector.tabHint")}</div>
          ) : null}
        </div>

        <div className="lm-room-dock-inspect" role="region" aria-label={t("roomMap.inspector.regionAriaLabel")}>
          {renderInspector()}
        </div>
      </div>
    </aside>
  );
}
