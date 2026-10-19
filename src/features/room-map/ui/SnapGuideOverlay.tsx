import { useTranslation } from "react-i18next";
import type { SnapGuide } from "../state/useSnapGuides";
import styles from "./SnapGuideOverlay.module.css";

interface SnapGuideOverlayProps {
  guides: SnapGuide[];
  pxPerMeter: number;
  canvasWidth: number;
  canvasHeight: number;
  zoom?: number;
}

export function SnapGuideOverlay({
  guides,
  pxPerMeter,
  canvasWidth,
  canvasHeight,
  zoom = 1,
}: SnapGuideOverlayProps) {
  const { t } = useTranslation();
  if (guides.length === 0) return null;
  // Edges, middles and lines read from the line itself; only a pair set up across the screen is named.
  const mirror = guides.find((g) => g.kind === "mirror" && g.at !== undefined);

  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0"
        style={{ zIndex: 50, overflow: "visible" }}
        width={canvasWidth}
        height={canvasHeight}
        data-testid="snap-guides"
      >
        {guides.map((guide, i) => {
          const posPx = guide.position * pxPerMeter;
          const [x1, y1, x2, y2] = guide.axis === "x" ? [posPx, 0, posPx, canvasHeight] : [0, posPx, canvasWidth, posPx];
          return (
            <line
              key={`${guide.axis}-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--lm-amber)"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              opacity={0.8}
            />
          );
        })}
      </svg>
      {mirror && (
        <span
          aria-hidden="true"
          className={styles.tag}
          style={{ left: mirror.position * pxPerMeter, top: mirror.at! * pxPerMeter, "--snap-tag-scale": 1 / zoom } as React.CSSProperties}
        >
          {t("roomMap:alignGuide.symmetric")}
        </span>
      )}
    </>
  );
}
