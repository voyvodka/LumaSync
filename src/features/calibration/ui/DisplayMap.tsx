import type { DisplayId, DisplayInfo } from "../../../shared/contracts/display";

interface DisplayMapProps {
  displays: DisplayInfo[];
  selectedId: DisplayId | null;
  activeId: DisplayId | null;
  isSwitching: boolean;
  onSelect: (displayId: DisplayId) => void;
  maxWidth?: number;
  maxHeight?: number;
}

const PADDING = 12;
const LED_DOT_RADIUS = 2.2;
const LED_DOTS_PER_100PX = 3.5;

const EDGE_COLORS = {
  top: "#34d399",
  right: "#a78bfa",
  bottom: "#fbbf24",
  left: "#60a5fa",
} as const;

function generateLedDots(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): Array<{ cx: number; cy: number; color: string }> {
  const dots: Array<{ cx: number; cy: number; color: string }> = [];

  const topCount = Math.max(2, Math.round((rw / 100) * LED_DOTS_PER_100PX));
  const rightCount = Math.max(2, Math.round((rh / 100) * LED_DOTS_PER_100PX));
  const bottomCount = topCount;
  const leftCount = rightCount;

  // Top edge
  for (let i = 0; i < topCount; i++) {
    dots.push({
      cx: rx + (rw / (topCount + 1)) * (i + 1),
      cy: ry,
      color: EDGE_COLORS.top,
    });
  }
  // Right edge
  for (let i = 0; i < rightCount; i++) {
    dots.push({
      cx: rx + rw,
      cy: ry + (rh / (rightCount + 1)) * (i + 1),
      color: EDGE_COLORS.right,
    });
  }
  // Bottom edge (reversed)
  for (let i = bottomCount - 1; i >= 0; i--) {
    dots.push({
      cx: rx + (rw / (bottomCount + 1)) * (i + 1),
      cy: ry + rh,
      color: EDGE_COLORS.bottom,
    });
  }
  // Left edge (reversed)
  for (let i = leftCount - 1; i >= 0; i--) {
    dots.push({
      cx: rx,
      cy: ry + (rh / (leftCount + 1)) * (i + 1),
      color: EDGE_COLORS.left,
    });
  }

  return dots;
}

export function DisplayMap({ displays, selectedId, activeId, isSwitching, onSelect, maxWidth = 320, maxHeight = 110 }: DisplayMapProps) {
  if (displays.length === 0) return null;

  // scaleFactor ile mantıksal (fiziksel görünüm) koordinatlara çevir
  const logical = displays.map((d) => {
    const sf = d.scaleFactor ?? 1;
    return {
      ...d,
      lx: d.x / sf,
      ly: d.y / sf,
      lw: d.width / sf,
      lh: d.height / sf,
    };
  });

  // Bounding box mantıksal koordinatlarda hesapla
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of logical) {
    minX = Math.min(minX, d.lx);
    minY = Math.min(minY, d.ly);
    maxX = Math.max(maxX, d.lx + d.lw);
    maxY = Math.max(maxY, d.ly + d.lh);
  }

  const totalW = maxX - minX;
  const totalH = maxY - minY;

  const scaleX = (maxWidth - PADDING * 2) / totalW;
  const scaleY = (maxHeight - PADDING * 2) / totalH;
  const scale = Math.min(scaleX, scaleY);

  const svgW = totalW * scale + PADDING * 2;
  const svgH = totalH * scale + PADDING * 2;

  return (
    <div className="flex flex-col items-start gap-2">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="overflow-visible"
        aria-label="Display layout"
      >
        <defs>
          <filter id="led-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="screen-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {logical.map((display, index) => {
          const rx = (display.lx - minX) * scale + PADDING;
          const ry = (display.ly - minY) * scale + PADDING;
          const rw = display.lw * scale;
          const rh = display.lh * scale;
          const isSelected = selectedId === display.id;
          const isActive = activeId === display.id;
          const dots = isSelected ? generateLedDots(rx, ry, rw, rh) : [];

          return (
            <g
              key={display.id}
              onClick={() => {
                if (!isSwitching) onSelect(display.id);
              }}
              style={{ cursor: isSwitching ? "not-allowed" : "pointer" }}
            >
              {/* Glow behind selected screen */}
              {isSelected && (
                <rect
                  x={rx - 2}
                  y={ry - 2}
                  width={rw + 4}
                  height={rh + 4}
                  rx={3}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={3}
                  opacity={0.35}
                  filter="url(#screen-glow)"
                />
              )}

              {/* Screen body */}
              <rect
                x={rx}
                y={ry}
                width={rw}
                height={rh}
                rx={2}
                fill={isSelected ? "rgba(34,211,238,0.08)" : "rgba(255,255,255,0.04)"}
                stroke={isSelected ? "#22d3ee" : "rgba(255,255,255,0.18)"}
                strokeWidth={isSelected ? 1.5 : 1}
              />

              {/* Screen index label */}
              <text
                x={rx + rw / 2}
                y={ry + rh / 2 + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={Math.max(7, Math.min(11, rh * 0.22))}
                fill={isSelected ? "rgba(34,211,238,0.9)" : "rgba(255,255,255,0.3)"}
                fontWeight="600"
                fontFamily="ui-monospace, monospace"
              >
                {index + 1}
              </text>

              {/* Active indicator dot */}
              {isActive && (
                <circle
                  cx={rx + rw - 4}
                  cy={ry + 4}
                  r={2.5}
                  fill="#34d399"
                  filter="url(#led-glow)"
                />
              )}

              {/* LED dots around selected display perimeter */}
              {isSelected && dots.map((dot, di) => (
                <circle
                  key={di}
                  cx={dot.cx}
                  cy={dot.cy}
                  r={LED_DOT_RADIUS}
                  fill={dot.color}
                  filter="url(#led-glow)"
                  opacity={0.85}
                />
              ))}
            </g>
          );
        })}
      </svg>

      {/* Labels below the SVG */}
      <div className="flex items-center gap-3">
        {logical.map((display, index) => {
          const isSelected = selectedId === display.id;
          return (
            <button
              key={display.id}
              type="button"
              onClick={() => { if (!isSwitching) onSelect(display.id); }}
              disabled={isSwitching}
              className={`text-left transition-colors disabled:opacity-40 ${
                isSelected ? "text-cyan-300" : "text-white/40 hover:text-white/70"
              }`}
            >
              <div className="text-[10px] font-semibold leading-tight">
                {display.label || `Display ${index + 1}`}
                {display.isPrimary && (
                  <span className="ml-1 opacity-60">★</span>
                )}
              </div>
              <div className="text-[9px] leading-tight opacity-60 tabular-nums">
                {Math.round(display.lw)}×{Math.round(display.lh)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
