import type { SnapGuide } from "./useSnapGuides";

interface SnapGuideOverlayProps {
  guides: SnapGuide[];
  pxPerMeter: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function SnapGuideOverlay({
  guides,
  pxPerMeter,
  canvasWidth,
  canvasHeight,
}: SnapGuideOverlayProps) {
  if (guides.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 50 }}
      width={canvasWidth}
      height={canvasHeight}
    >
      {guides.map((guide, i) => {
        const posPx = guide.position * pxPerMeter;
        if (guide.axis === "x") {
          return (
            <line
              key={`x-${i}`}
              x1={posPx}
              y1={0}
              x2={posPx}
              y2={canvasHeight}
              stroke="#06b6d4"
              strokeWidth={1}
              strokeDasharray="4 3"
              opacity={0.8}
            />
          );
        }
        return (
          <line
            key={`y-${i}`}
            x1={0}
            y1={posPx}
            x2={canvasWidth}
            y2={posPx}
            stroke="#06b6d4"
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.8}
          />
        );
      })}
    </svg>
  );
}
