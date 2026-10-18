import { classifyFurniture, furnitureColours } from "@/features/room-view/model/furnitureModel";
import { type RoomMapConfig, stripPoints } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";

import { FurnitureGlyph } from "./objects/FurnitureGlyph";
import styles from "./RoomPreview.module.css";

/** A whole room from above at a glance — the outline, the screen, the strips and every piece drawn
 *  as the plan draws it. For choosing a room, not editing one. */
export function RoomPreview({ config, className }: { config: RoomMapConfig; className?: string }) {
  const { widthMeters: w, depthMeters: d } = config.dimensions;
  const models = classifyFurniture(config);
  const pad = Math.max(w, d) * 0.04;
  const tv = config.tvAnchor;
  return (
    <svg
      className={cx(styles.preview, className)}
      viewBox={`${-pad} ${-pad} ${w + pad * 2} ${d + pad * 2}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect className={styles.floor} x={0} y={0} width={w} height={d} rx={0.04} />
      {config.furniture.map((item) => {
        const model = models.get(item.id) ?? { kind: "box" as const };
        const cxM = item.x + item.width / 2;
        const cyM = item.y + item.height / 2;
        return (
          <g key={item.id} transform={item.rotation ? `rotate(${item.rotation} ${cxM} ${cyM})` : undefined}>
            <svg x={item.x} y={item.y} width={item.width} height={item.height} overflow="visible">
              <FurnitureGlyph model={model} colours={furnitureColours(item, model)} width={item.width} depth={item.height} />
            </svg>
          </g>
        );
      })}
      {config.usbStrips.map((strip) => (
        <polyline
          key={strip.stripId}
          className={styles.strip}
          fill="none"
          points={stripPoints(strip)
            .map((p) => `${p.x},${p.y}`)
            .join(" ")}
        />
      ))}
      {tv && <line className={styles.screen} x1={tv.x} y1={tv.y + tv.height / 2} x2={tv.x + tv.width} y2={tv.y + tv.height / 2} />}
    </svg>
  );
}
