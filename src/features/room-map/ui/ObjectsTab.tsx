import { useTranslation } from "react-i18next";

import type { HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";
import { ObjectRow } from "./ObjectRow";
import { buildObjectList, type ObjectRowEntry } from "../model/objectList";
import { getZoneColor, TYPE_DOT_COLOR } from "../model/zoneColor";
import { parseObjectId } from "../model/objectId";

interface ObjectsTabProps {
  config: RoomMapConfig;
  selectedId: string | null;
  hueZones: HueZone[];
  /**
   * v1.5 W4-F2 manual-test (2026-04-28) — id of the currently
   * selected Hue zone in the room editor (mirrors `activeHueZoneId`
   * upstream). Drives the "is-on" highlight on zone headers in the
   * Objects list so the user can tell which zone the bottom inspector
   * belongs to.
   */
  activeHueZoneId: string | null;
  onSelect: (id: string) => void;
  /**
   * v1.5 W4-F2 manual-test (2026-04-28) — clicking a Hue zone header
   * in the Objects list selects it for the bottom inspector. Inert
   * when omitted so embeds without zone editing keep the headers
   * read-only.
   */
  onSelectHueZone?: (zoneId: string | null) => void;
  onDelete: (id: string) => void;
  onRenameFurniture: (id: string, label: string) => void;
  onToggleLock: (id: string) => void;
}

export function ObjectsTab(props: ObjectsTabProps) {
  const {
    config,
    selectedId,
    hueZones,
    activeHueZoneId,
    onSelect,
    onSelectHueZone,
    onDelete,
    onRenameFurniture,
    onToggleLock,
  } = props;
  const { t } = useTranslation();
  const rows = buildObjectList(config, t);
  if (rows.length === 0) {
    return <div className="lm-room-dock-empty">{t("roomMap:objectPanel.empty")}</div>;
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
              ? (label) => {
                  const parsed = parseObjectId(entry.id);
                  if (parsed?.kind === "furniture") onRenameFurniture(parsed.furnitureId, label);
                }
              : undefined
          }
          onToggleLock={() => onToggleLock(entry.id)}
        />
      ))}

      {hueZones.map((zone, zi) => {
        const bucket = hueByZone.get(zone.id) ?? [];
        const color = getZoneColor(zone, zi);
        const isZoneActive = activeHueZoneId === zone.id;
        const zoneSelectable = !!onSelectHueZone;
        return (
          <li key={`zone-${zone.id}`}>
            {/*
              v1.5 W4-F2 manual-test (2026-04-28): zone headers in the
              Objects list are now clickable — selecting one routes the
              Hue zone inspector into the bottom dock without forcing
              the user to switch to the Hue Zones tab. The header acts
              as a toggle so a second click re-deselects the zone.
            */}
            <div
              className={[
                "lm-room-dock-h",
                zoneSelectable ? "is-clickable" : "",
                isZoneActive ? "is-on" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              role={zoneSelectable ? "button" : "heading"}
              aria-level={zoneSelectable ? undefined : 3}
              aria-pressed={zoneSelectable ? isZoneActive : undefined}
              tabIndex={zoneSelectable ? 0 : undefined}
              onClick={
                zoneSelectable
                  ? () => onSelectHueZone(isZoneActive ? null : zone.id)
                  : undefined
              }
              onKeyDown={
                zoneSelectable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectHueZone(isZoneActive ? null : zone.id);
                      }
                    }
                  : undefined
              }
            >
              <span className="lm-room-dock-h-dot" style={{ background: color }} aria-hidden />
              <span className="lm-room-dock-h-name">{zone.name}</span>
              <span className="lm-room-dock-h-count">{bucket.length}</span>
            </div>
            {bucket.length === 0 ? (
              <div className="lm-room-dock-empty" style={{ padding: "4px 8px", textAlign: "left" }}>
                {t("roomMap:hueZones.groupEmpty")}
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
            <span className="lm-room-dock-h-name">{t("roomMap:hueZones.unassignedTitle")}</span>
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
