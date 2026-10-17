import { type KeyboardEvent, type MouseEvent, type RefObject, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { IconLockClosed } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";

import { buildObjectList, type ObjectRowEntry } from "../../model/objectList";
import { getZoneColor, TYPE_DOT_COLOR } from "../../model/zoneColor";
import styles from "./ObjectsPopover.module.css";

type Pick = (event: MouseEvent<HTMLButtonElement>) => void;

export interface ObjectsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  /** The map with only the shown area's channels. */
  config: RoomMapConfig;
  /** The shown area's zones. */
  zones: readonly HueZone[];
  selectedId: string | null;
  activeHueZoneId: string | null;
  onSelect: (objectId: string, event: MouseEvent<HTMLButtonElement>) => void;
  onSelectZone: (zoneId: string, event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Everything in the room as one list, the Hue lights under their zones: the way to reach a piece
 * hidden under the dock, and the keyboard's way to select one at all. ↑/↓, Home and End move
 * between rows; a press selects and closes.
 */
export function ObjectsPopover({ open, onClose, anchorRef, id, config, zones, selectedId, activeHueZoneId, onSelect, onSelectZone }: ObjectsPopoverProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const rows = buildObjectList(config, t);
  const room = rows.filter((row) => row.type !== "hue");
  const lights = rows.filter((row) => row.type === "hue");
  const unassigned = lights.filter((row) => !row.zoneId || !zones.some((z) => z.id === row.zoneId));

  // Opening lands on the selection, or the first row, so the arrows have somewhere to start.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const target = list?.querySelector<HTMLElement>('[aria-current="true"]') ?? list?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? buttons[Math.min(buttons.length - 1, at + 1)]
        : event.key === "ArrowUp"
          ? buttons[Math.max(0, at - 1)]
          : event.key === "Home"
            ? buttons[0]
            : event.key === "End"
              ? buttons[buttons.length - 1]
              : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const row = (entry: ObjectRowEntry, colour: string, nested = false) => (
    <Row
      key={entry.id}
      label={entry.label}
      colour={colour}
      locked={!!entry.locked}
      current={selectedId === entry.id}
      nested={nested}
      onClick={(event) => onSelect(entry.id, event)}
    />
  );

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side="above" width={288} id={id} label={t("roomMap:dock.objects")} role="dialog" childScrolls>
      <div ref={listRef} className={styles.list} onKeyDown={onKeyDown}>
        {rows.length === 0 && zones.length === 0 ? (
          <p className={styles.empty}>{t("roomMap:objectPanel.empty")}</p>
        ) : (
          <>
            {room.map((entry) => row(entry, TYPE_DOT_COLOR[entry.type]))}
            {(lights.length > 0 || zones.length > 0) && (
              <>
                <h3 className={styles.heading}>{t("roomMap:objects.hueLights")}</h3>
                {zones.map((zone, i) => {
                  const colour = getZoneColor(zone, i);
                  const members = lights.filter((entry) => entry.zoneId === zone.id);
                  return (
                    <div key={zone.id} role="group" aria-label={zone.name}>
                      <Row
                        label={zone.name}
                        colour={colour}
                        disc
                        count={members.length}
                        countLabel={t("roomMap:inspector.zoneChannelCount", { count: members.length })}
                        current={activeHueZoneId === zone.id && selectedId === null}
                        onClick={(event) => onSelectZone(zone.id, event)}
                      />
                      {members.map((entry) => row(entry, colour, true))}
                    </div>
                  );
                })}
                {unassigned.length > 0 && (
                  <div role="group" aria-label={t("roomMap:hueZones.unassignedTitle")}>
                    {zones.length > 0 && <p className={styles.subheading}>{t("roomMap:hueZones.unassignedTitle")}</p>}
                    {unassigned.map((entry) => row(entry, TYPE_DOT_COLOR.hue, zones.length > 0))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Popover>
  );
}

function Row({
  label,
  colour,
  disc = false,
  count,
  countLabel,
  locked = false,
  current,
  nested = false,
  onClick,
}: {
  label: string;
  colour: string;
  /** A zone: a filled disc rather than a dot. */
  disc?: boolean;
  count?: number;
  /** The count in words, read after the name. */
  countLabel?: string;
  locked?: boolean;
  current: boolean;
  nested?: boolean;
  onClick: Pick;
}) {
  return (
    <button
      type="button"
      className={cx(styles.row, nested && styles.nested, disc && styles.zone)}
      aria-current={current || undefined}
      aria-label={countLabel ? `${label}, ${countLabel}` : undefined}
      title={label}
      onClick={onClick}
    >
      <span className={cx(styles.dot, disc && styles.disc)} style={{ background: colour }} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {count !== undefined && (
        <span className={styles.count} aria-hidden="true">
          {count}
        </span>
      )}
      {locked && (
        <span className={styles.lock} aria-hidden="true">
          <IconLockClosed />
        </span>
      )}
    </button>
  );
}
