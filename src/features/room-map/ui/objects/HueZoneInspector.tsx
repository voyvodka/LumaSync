import { type CSSProperties, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { clamp, roundTo } from "@/shared/lib/math";
import { useSideScroll } from "@/shared/lib/useSideScroll";

import { hueChannelDotText, hueChannelName } from "../../model/hueChannelLabel";
import { hueToMetres } from "../../model/hueChannelPosition";
import { getZoneColor } from "../../model/zoneColor";
import { withCubeScale } from "../../model/zoneCube";
import { ZONE_SCALE_MIN } from "../../model/zoneRect";
import { DecimalField } from "../DecimalField";
import { ZoneSwatches } from "../dock/DockSwatches";
import { Actions, Disc, FieldRow, InspectorRows, Mark, Meta, NameField, Spacer } from "../dock/InspectorParts";
import { GlyphHeight, GlyphWidth } from "./fieldGlyphs";
import styles from "./HueZoneInspector.module.css";

export function HueZoneInspector({
  zone,
  zoneIndex,
  zones,
  channels,
  roomWidthM,
  roomDepthM,
  roomHeightM,
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
  /** Turn the cube's scale into metres for the readout and the height; `0` before the map loads
   *  disables the fields rather than dividing by it. */
  roomWidthM: number;
  roomDepthM: number;
  roomHeightM: number;
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
  const heightM = Math.max(0, roomHeightM);
  const sized = widthM > 0 && depthM > 0 && heightM > 0;
  // One scale on all three axes: a share of each side of the room, in the room's proportions.
  const scale = Math.abs(Number.isFinite(zone.scaleX) ? zone.scaleX : ZONE_SCALE_MIN);
  // Grown about its centre, so the far side stops at the nearest wall, floor or ceiling: Rust
  // refuses `|center| + scale > 1`.
  const maxScale = Math.max(ZONE_SCALE_MIN, 1 - Math.max(Math.abs(zone.centerX), Math.abs(zone.centerY), Math.abs(zone.centerZ)));
  const centreM = hueToMetres(zone.centerZ, heightM);
  const halfH = (scale * heightM) / 2;
  const metres = (m: number) => m.toFixed(2);
  const cube = (next: HueZone) => {
    const { centerX, centerY, centerZ, scaleX, scaleY, scaleZ } = next;
    onUpdate({ centerX, centerY, centerZ, scaleX, scaleY, scaleZ });
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
          <FieldRow>
            <DecimalField
              label={t("roomMap:inspector.zoneSizeLabel")}
              prefix={<GlyphWidth />}
              value={scale * 100}
              decimals={0}
              // Rounded as shown, so a size on screen can be typed back; the clamp holds the exact range.
              min={Math.round(ZONE_SCALE_MIN * 100)}
              max={Math.floor(maxScale * 100)}
              unit="%"
              disabled={!sized}
              testId="hue-zone-size-input"
              onCommit={(pct) => cube(withCubeScale(zone, clamp(pct / 100, ZONE_SCALE_MIN, maxScale)))}
            />
            <Meta>
              {t("roomMap:inspector.zoneSizeReadout", { width: metres(scale * widthM), depth: metres(scale * depthM), height: metres(scale * heightM) })}
            </Meta>
            <DecimalField
              label={t("roomMap:inspector.zoneHeightLabel")}
              prefix={<GlyphHeight />}
              value={centreM}
              min={roundTo(halfH, 2)}
              max={roundTo(heightM - halfH, 2)}
              unit="m"
              disabled={!sized}
              testId="hue-zone-height-input"
              onCommit={(m) => cube(withCubeScale(zone, scale, { x: zone.centerX, y: zone.centerY, z: (clamp(m, halfH, heightM - halfH) / heightM) * 2 - 1 }))}
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
