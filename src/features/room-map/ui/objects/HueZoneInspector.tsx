import { type CSSProperties, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { clamp, roundTo } from "@/shared/lib/math";
import { useSideScroll } from "@/shared/lib/useSideScroll";

import { hueChannelDotText, hueChannelName } from "../../model/hueChannelLabel";
import { hueToMetres } from "../../model/hueChannelPosition";
import { getZoneColor } from "../../model/zoneColor";
import { maxZoneEdgeAt, withCubeEdge, zoneEdge } from "../../model/zoneCube";
import { zoneEdgeBounds } from "../../model/zoneRect";
import { DecimalField } from "../DecimalField";
import { ZoneSwatches } from "../dock/DockSwatches";
import { Actions, Disc, FieldRow, InspectorRows, Mark, NameField, Spacer } from "../dock/InspectorParts";
import { GlyphHeight, GlyphWidth } from "./fieldGlyphs";
import styles from "./HueZoneInspector.module.css";

const SHAPE = ["centerX", "centerY", "centerZ", "scaleX", "scaleY", "scaleZ"] as const;

export function HueZoneInspector({
  zone,
  zoneIndex,
  zones,
  channels,
  roomWidthM,
  roomDepthM,
  roomHeightM,
  onUpdate,
  onPreview,
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
  /** Turn the cube's scales into its edge and height in metres; `0` before the map loads disables
   *  the fields rather than dividing by it. */
  roomWidthM: number;
  roomDepthM: number;
  roomHeightM: number;
  onUpdate: (patch: Partial<HueZone>) => void;
  /** Shows the zone a drag across a field has reached without saving it; false when nothing can. */
  onPreview?: (zone: HueZone | null) => boolean;
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
  // A drag across a field rebuilt the 3D room each step; it is shown held instead and saved once on release.
  const [dragged, setDragged] = useState<HueZone | null>(null);
  const shown = dragged ?? zone;

  const widthM = Math.max(0, roomWidthM);
  const depthM = Math.max(0, roomDepthM);
  const heightM = Math.max(0, roomHeightM);
  const sized = widthM > 0 && depthM > 0 && heightM > 0;
  const room = { widthMeters: widthM, depthMeters: depthM, heightMeters: heightM };
  const bounds = sized ? zoneEdgeBounds(widthM, depthM, heightM) : { min: 0, max: 0 };
  const edge = sized ? zoneEdge(shown, room) : 0;
  // Grown about its centre, so the far side stops at the nearest wall, floor or ceiling: Rust
  // refuses `|center| + scale > 1`.
  const maxEdge = sized ? maxZoneEdgeAt(shown, room) : 0;
  const centreM = hueToMetres(shown.centerZ, heightM);
  const halfH = edge / 2;
  const cube = (next: HueZone) => {
    const { centerX, centerY, centerZ, scaleX, scaleY, scaleZ } = next;
    onUpdate({ centerX, centerY, centerZ, scaleX, scaleY, scaleZ });
  };
  const step = (next: HueZone, held = false) => {
    if (held && onPreview?.(next)) setDragged(next);
    else cube(next);
  };
  // Saved, it stays held until the room is built with it: putting it back first flashed the old zone.
  const letGo = () => {
    if (!dragged) return;
    setDragged(null);
    if (SHAPE.every((key) => dragged[key] === zone[key])) onPreview?.(null);
    else cube(dragged);
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
              value={edge}
              // Rounded as shown, so an edge on screen can be typed back; the clamp holds the exact range.
              min={roundTo(bounds.min, 2)}
              max={Math.floor(maxEdge * 100) / 100}
              unit="m"
              disabled={!sized}
              testId="hue-zone-size-input"
              onCommit={(m, held) => step(withCubeEdge(shown, clamp(m, bounds.min, maxEdge), room), held)}
              onScrubEnd={letGo}
            />
            <DecimalField
              label={t("roomMap:inspector.zoneHeightLabel")}
              prefix={<GlyphHeight />}
              value={centreM}
              min={roundTo(halfH, 2)}
              max={roundTo(heightM - halfH, 2)}
              unit="m"
              disabled={!sized}
              testId="hue-zone-height-input"
              onCommit={(m, held) => step(withCubeEdge(shown, edge, room, { x: shown.centerX, y: shown.centerY, z: (clamp(m, halfH, heightM - halfH) / heightM) * 2 - 1 }), held)}
              onScrubEnd={letGo}
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
