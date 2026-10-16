import { type CSSProperties, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { clamp, roundTo } from "@/shared/lib/math";
import { useSideScroll } from "@/shared/lib/useSideScroll";

import { hueChannelDotText, hueChannelName } from "../../model/hueChannelLabel";
import { getZoneColor } from "../../model/zoneColor";
import { ZONE_SCALE_MIN, zoneMinSize } from "../../model/zoneRect";
import { DecimalField } from "../DecimalField";
import { ZoneSwatches } from "../dock/DockSwatches";
import { Actions, Disc, FieldRow, InspectorRows, Mark, NameField, Spacer } from "../dock/InspectorParts";
import { GlyphDepth, GlyphWidth } from "./fieldGlyphs";
import styles from "./HueZoneInspector.module.css";

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return ZONE_SCALE_MIN;
  return clamp(value, ZONE_SCALE_MIN, 1);
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
  /** Turn the sides in metres into the per-axis cube scales the bridge stores; `0` before the map
   *  loads disables the fields rather than dividing by it. */
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

  const widthM = Math.max(0, roomWidthM);
  const depthM = Math.max(0, roomDepthM);
  const sized = widthM > 0 && depthM > 0;
  const min = zoneMinSize(widthM, depthM);
  // Grown about its centre, so the far side stops at the nearer wall: Rust refuses
  // `|center| + scale > 1`. Floored at the minimum so a legacy zone past a wall stays editable.
  const maxW = Math.max(min.w, (1 - Math.abs(zone.centerX)) * widthM);
  const maxD = Math.max(min.d, (1 - Math.abs(zone.centerY)) * depthM);
  const sideW = Math.abs(Number.isFinite(zone.scaleX) ? zone.scaleX : ZONE_SCALE_MIN) * widthM;
  const sideD = Math.abs(Number.isFinite(zone.scaleY) ? zone.scaleY : ZONE_SCALE_MIN) * depthM;

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
          <FieldRow>
            <DecimalField
              label={t("roomMap:inspector.widthLabel")}
              prefix={<GlyphWidth />}
              value={sideW}
              // Rounded as shown, so a size on screen can be typed back; the clamp holds the exact range.
              min={roundTo(min.w, 2)}
              max={roundTo(maxW, 2)}
              unit="m"
              disabled={!sized}
              testId="hue-zone-width-input"
              onCommit={(m) => onUpdate({ scaleX: clampScale(clamp(m, min.w, maxW) / widthM) })}
            />
            <DecimalField
              label={t("roomMap:inspector.depthLabel")}
              prefix={<GlyphDepth />}
              value={sideD}
              min={roundTo(min.d, 2)}
              max={roundTo(maxD, 2)}
              unit="m"
              disabled={!sized}
              testId="hue-zone-depth-input"
              onCommit={(m) => onUpdate({ scaleY: clampScale(clamp(m, min.d, maxD) / depthM) })}
            />
          </FieldRow>
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
