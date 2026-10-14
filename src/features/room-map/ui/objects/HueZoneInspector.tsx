import { type CSSProperties, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { clamp, roundTo } from "@/shared/lib/math";
import { useSideScroll } from "@/shared/lib/useSideScroll";

import { hueChannelDotText, hueChannelName } from "../../model/hueChannelLabel";
import { getZoneColor } from "../../model/zoneColor";
import { DecimalField } from "../DecimalField";
import { ZoneSwatches } from "../dock/DockSwatches";
import { Actions, Disc, InspectorRows, Mark, NameField, Spacer } from "../dock/InspectorParts";
import { GlyphWidth } from "./fieldGlyphs";
import styles from "./HueZoneInspector.module.css";

// Mirrors `HUE_ZONE_SCALE_MIN` / `HUE_ZONE_SCALE_MAX` in
// `commands/room_map/hue_zone.rs` — the two must move together. Each axis is
// clamped through this band even though the field edits metres.
const SCALE_MIN = 0.05;
const SCALE_MAX = 1;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return SCALE_MIN;
  return clamp(value, SCALE_MIN, SCALE_MAX);
}

/**
 * The zone's physical edge from its cube-space scales. A legacy zone, or one a third party wrote,
 * may carry asymmetric scales; the smaller physical edge keeps it inside its persisted bounds on
 * first edit.
 */
function resolvePhysicalEdgeM(zone: HueZone, roomWidthM: number, roomDepthM: number): number {
  if (roomWidthM <= 0 || roomDepthM <= 0) return 0;
  const sx = Number.isFinite(zone.scaleX) ? zone.scaleX : SCALE_MIN;
  const sy = Number.isFinite(zone.scaleY) ? zone.scaleY : SCALE_MIN;
  return Math.min(Math.max(0, sx) * roomWidthM, Math.max(0, sy) * roomDepthM);
}

export function HueZoneInspector({
  zone,
  zoneIndex,
  zones,
  channels,
  roomWidthM,
  roomDepthM,
  onUpdate,
  onRename,
  onAssignChannel,
  onDelete,
  onClose,
}: {
  zone: HueZone;
  /** Its place among the zones, for the palette colour a zone with none of its own takes. */
  zoneIndex: number;
  /** Every zone of the area, so a light in another one can say which. */
  zones: readonly HueZone[];
  /** The area's lights: each one a chip that joins or leaves this zone. */
  channels: readonly HueChannelPlacement[];
  /** Translate the edge in metres into the per-axis cube scales the bridge stores; `0` before the
   *  map loads disables the field rather than dividing by it. */
  roomWidthM: number;
  roomDepthM: number;
  onUpdate: (patch: Partial<HueZone>) => void;
  onRename: (name: string) => void;
  /** Moves a light into a zone, or out of every zone for `null`. */
  onAssignChannel: (channelIndex: number, zoneId: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const colour = getZoneColor(zone, zoneIndex);
  const listRef = useRef<HTMLDivElement | null>(null);
  const more = useSideScroll(listRef, channels.map((ch) => ch.channelIndex).join(), undefined);

  const safeWidthM = Math.max(0, roomWidthM);
  const safeDepthM = Math.max(0, roomDepthM);
  // The largest square that fits the room footprint.
  const roomMaxEdgeM = Math.min(safeWidthM, safeDepthM);
  // `SCALE_MIN` against the smaller room axis, mirroring Rust: 0.20 m in a
  // 5×4 m room — a single-bulb zone that still has cube resolution left.
  const minEdgeM = SCALE_MIN * roomMaxEdgeM;
  // Rust refuses `|center| + scale > 1`, so a zone parked near a wall has less
  // headroom than the room does. Floored at `minEdgeM` to keep legacy escapees usable.
  const maxEdgeM = Math.max(
    minEdgeM,
    Math.min(roomMaxEdgeM, (1 - Math.abs(zone.centerX)) * safeWidthM, (1 - Math.abs(zone.centerY)) * safeDepthM),
  );
  const currentEdgeM = resolvePhysicalEdgeM(zone, safeWidthM, safeDepthM);

  // One metre value drives both axes, and in a non-square room they diverge on
  // purpose so the zone stays a physical square. See docs/architecture/room-map.md.
  const setEdgeM = (rawMetres: number) => {
    if (roomMaxEdgeM <= 0) return;
    const clampedM = clamp(rawMetres, minEdgeM, maxEdgeM);
    onUpdate({ scaleX: clampScale(clampedM / safeWidthM), scaleY: clampScale(clampedM / safeDepthM) });
  };

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <Disc fill={colour} />
          </Mark>
          <NameField
            first
            value={zone.name}
            fallback={t("roomMap:hueZones.defaultName", { N: String(zoneIndex + 1) })}
            label={t("roomMap:inspector.furnitureNameLabel")}
            onCommit={onRename}
          />
          <ZoneSwatches value={zone.borderColor} onChange={(borderColor) => onUpdate({ borderColor })} />
          <Spacer />
          <Actions locked={false} onDelete={onDelete} onClose={onClose} />
        </>
      }
      second={
        <>
          <DecimalField
            className={styles.edge}
            label={t("roomMap:inspector.zoneEdgeAriaLabel")}
            prefix={<GlyphWidth />}
            value={currentEdgeM}
            // Rounded as shown, so the edge on screen can be typed back; setEdgeM holds the exact range.
            min={roundTo(minEdgeM, 2)}
            max={roundTo(maxEdgeM, 2)}
            unit="m"
            disabled={maxEdgeM <= 0}
            testId="hue-zone-size-edge-input"
            onCommit={setEdgeM}
          />
          <span className={styles.caption}>{t("roomMap:inspector.hueLightCountLabel")}</span>
          <div ref={listRef} className={styles.chips} data-more={more} role="group" aria-label={t("roomMap:inspector.hueLightCountLabel")}>
            {channels.map((ch) => {
              const member = ch.zoneId === zone.id;
              const elsewhereIndex = !member && ch.zoneId ? zones.findIndex((z) => z.id === ch.zoneId) : -1;
              const elsewhere = elsewhereIndex >= 0 ? zones[elsewhereIndex] : undefined;
              const name = hueChannelName(ch, t);
              return (
                <button
                  key={ch.channelIndex}
                  type="button"
                  className={cx(styles.chip, member && styles.member)}
                  style={member ? ({ "--ring": colour } as CSSProperties) : undefined}
                  aria-label={name}
                  aria-pressed={member}
                  title={elsewhere ? `${name} · ${t("roomMap:inspector.zoneChipElsewhere", { zone: elsewhere.name })}` : name}
                  // A locked light keeps its place, and joining a zone moves it to the zone's centre.
                  disabled={!!ch.locked}
                  data-testid={`hue-zone-chip-${ch.channelIndex}`}
                  onClick={() => onAssignChannel(ch.channelIndex, member ? null : zone.id)}
                >
                  {hueChannelDotText(ch.channelId)}
                  {elsewhere && (
                    <span className={styles.elsewhere} style={{ background: getZoneColor(elsewhere, elsewhereIndex) }} aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      }
    />
  );
}
