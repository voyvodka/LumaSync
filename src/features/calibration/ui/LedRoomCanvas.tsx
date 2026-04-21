import type { LedCalibrationConfig, LedStartAnchor } from "../model/contracts";

interface LedRoomCanvasProps {
  config: LedCalibrationConfig;
}

const VIEW_W = 700;
const VIEW_H = 340;

const MON_X = 180;
const MON_Y = 62;
const MON_W = 340;
const MON_H = 196;
const SCR_INSET = 8;
const DOT_OFFSET = 6;
const DOT_R = 3.2;

function evenlySpaced(from: number, to: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [(from + to) / 2];
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) => from + step * i);
}

function computeBottomDotXs(countBottom: number, bottomMissing: number): number[] {
  if (countBottom <= 0) return [];

  const from = MON_X + DOT_OFFSET;
  const to = MON_X + MON_W - DOT_OFFSET;

  if (bottomMissing <= 0) {
    return evenlySpaced(from, to, countBottom);
  }

  const totalSlots = countBottom + bottomMissing;
  if (totalSlots <= 1) return evenlySpaced(from, to, countBottom);

  const step = (to - from) / (totalSlots - 1);
  const leftHalf = Math.floor(countBottom / 2);
  const result: number[] = [];
  for (let i = 0; i < leftHalf; i += 1) {
    result.push(from + step * i);
  }
  for (let i = 0; i < countBottom - leftHalf; i += 1) {
    result.push(from + step * (leftHalf + bottomMissing + i));
  }
  return result;
}

function anchorPosition(
  anchor: LedStartAnchor,
  bottomXs: number[],
  countBottom: number,
): { x: number; y: number; tailDx: number; tailDy: number } {
  const bottomY = MON_Y + MON_H + DOT_OFFSET;
  switch (anchor) {
    case "top-start":
      return { x: MON_X + DOT_OFFSET, y: MON_Y - DOT_OFFSET, tailDx: 20, tailDy: 0 };
    case "top-end":
      return { x: MON_X + MON_W - DOT_OFFSET, y: MON_Y - DOT_OFFSET, tailDx: -20, tailDy: 0 };
    case "right-start":
      return { x: MON_X + MON_W + DOT_OFFSET, y: MON_Y + DOT_OFFSET, tailDx: 0, tailDy: 20 };
    case "right-end":
      return { x: MON_X + MON_W + DOT_OFFSET, y: MON_Y + MON_H - DOT_OFFSET, tailDx: 0, tailDy: -20 };
    case "bottom-start":
      return {
        x: bottomXs[0] ?? MON_X + DOT_OFFSET,
        y: bottomY,
        tailDx: 20,
        tailDy: 0,
      };
    case "bottom-end":
      return {
        x: bottomXs[bottomXs.length - 1] ?? MON_X + MON_W - DOT_OFFSET,
        y: bottomY,
        tailDx: -20,
        tailDy: 0,
      };
    case "bottom-gap-right": {
      const leftHalf = Math.floor(countBottom / 2);
      const idx = Math.min(bottomXs.length - 1, Math.max(0, leftHalf - 1));
      return { x: bottomXs[idx] ?? MON_X + DOT_OFFSET, y: bottomY, tailDx: -20, tailDy: 0 };
    }
    case "bottom-gap-left": {
      const leftHalf = Math.floor(countBottom / 2);
      const idx = Math.min(bottomXs.length - 1, Math.max(0, leftHalf));
      return { x: bottomXs[idx] ?? MON_X + MON_W - DOT_OFFSET, y: bottomY, tailDx: 20, tailDy: 0 };
    }
    case "left-start":
      return { x: MON_X - DOT_OFFSET, y: MON_Y + DOT_OFFSET, tailDx: 0, tailDy: 20 };
    case "left-end":
      return { x: MON_X - DOT_OFFSET, y: MON_Y + MON_H - DOT_OFFSET, tailDx: 0, tailDy: -20 };
  }
}

/**
 * LedRoomCanvas — presentational SVG showing the monitor + desk illustration
 * with LED dots distributed around the monitor according to `config.counts`.
 * Read-only: all editing happens via the dock on the right.
 */
export function LedRoomCanvas({ config }: LedRoomCanvasProps) {
  const { counts, bottomMissing, startAnchor, direction } = config;

  const topXs = evenlySpaced(MON_X + DOT_OFFSET, MON_X + MON_W - DOT_OFFSET, counts.top);
  const botXs = computeBottomDotXs(counts.bottom, bottomMissing);
  const rightYs = evenlySpaced(MON_Y + DOT_OFFSET, MON_Y + MON_H - DOT_OFFSET, counts.right);
  const leftYs = evenlySpaced(MON_Y + DOT_OFFSET, MON_Y + MON_H - DOT_OFFSET, counts.left);

  const anchor = anchorPosition(startAnchor, botXs, counts.bottom);
  const tailDx = direction === "cw" ? anchor.tailDx : -anchor.tailDx;
  const tailDy = direction === "cw" ? anchor.tailDy : -anchor.tailDy;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="lrc-glow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#ffb030" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#ff7a1a" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#ff7a1a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lrc-screen" x1="0" x2="1">
          <stop offset="0" stopColor="#ffb873" />
          <stop offset="0.25" stopColor="#d9521e" />
          <stop offset="0.5" stopColor="#6a2860" />
          <stop offset="0.75" stopColor="#1e3a6b" />
          <stop offset="1" stopColor="#0a2445" />
        </linearGradient>
        <linearGradient id="lrc-desk" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1a1720" />
          <stop offset="1" stopColor="#0a0c14" />
        </linearGradient>
        <filter id="lrc-soft">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <marker
          id="lrc-arr"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="#ffb020" />
        </marker>
      </defs>

      {/* Ambient wall glow */}
      <ellipse cx={VIEW_W / 2} cy="140" rx="320" ry="130" fill="url(#lrc-glow)" filter="url(#lrc-soft)" />

      {/* Desk surface */}
      <path d={`M70 270 L${VIEW_W - 70} 270 L${VIEW_W - 70} ${VIEW_H} L70 ${VIEW_H} Z`} fill="url(#lrc-desk)" />
      <line x1="70" y1="270" x2={VIEW_W - 70} y2="270" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" />

      {/* Monitor stand */}
      <rect x={MON_X + MON_W / 2 - 25} y="250" width="50" height="22" fill="#0d0f14" stroke="rgba(255,255,255,0.1)" />
      <rect x={MON_X + MON_W / 2 - 60} y="268" width="120" height="5" rx="2" fill="#14171d" stroke="rgba(255,255,255,0.1)" />

      {/* Monitor back glow (wider than monitor) */}
      <ellipse cx={MON_X + MON_W / 2} cy="145" rx="280" ry="80" fill="url(#lrc-screen)" opacity="0.4" filter="url(#lrc-soft)" />

      {/* Monitor frame */}
      <rect x={MON_X} y={MON_Y} width={MON_W} height={MON_H} rx="5" fill="#05070d" stroke="rgba(255,255,255,0.2)" strokeWidth="1.4" />
      {/* Screen */}
      <rect x={MON_X + SCR_INSET} y={MON_Y + SCR_INSET} width={MON_W - SCR_INSET * 2} height={MON_H - SCR_INSET * 2} rx="2" fill="#0a1220" />
      <rect x={MON_X + SCR_INSET} y={MON_Y + SCR_INSET} width={MON_W - SCR_INSET * 2} height={MON_H - SCR_INSET * 2} rx="2" fill="url(#lrc-screen)" opacity="0.9" />

      {/* Capture region indicator */}
      <g opacity="0.9">
        <rect
          x={MON_X + 50}
          y={MON_Y + 52}
          width={MON_W - 100}
          height={MON_H - 104}
          rx="4"
          fill="none"
          stroke="rgba(34,211,238,0.35)"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
      </g>

      {/* LED dots */}
      <g>
        {topXs.map((x, i) => (
          <circle key={`t-${i}`} cx={x} cy={MON_Y - DOT_OFFSET} r={DOT_R} fill="#ff8e24" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        ))}
        {rightYs.map((y, i) => (
          <circle key={`r-${i}`} cx={MON_X + MON_W + DOT_OFFSET} cy={y} r={DOT_R} fill="#2a4a82" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        ))}
        {botXs.map((x, i) => (
          <circle key={`b-${i}`} cx={x} cy={MON_Y + MON_H + DOT_OFFSET} r={DOT_R} fill="#0a1830" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        ))}
        {leftYs.map((y, i) => (
          <circle key={`l-${i}`} cx={MON_X - DOT_OFFSET} cy={y} r={DOT_R} fill="#d9761e" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        ))}
      </g>

      {/* Start marker + direction arrow */}
      {config.totalLeds > 0 && (
        <g>
          <circle cx={anchor.x} cy={anchor.y} r="7" fill="none" stroke="#ffb020" strokeWidth="1.5" strokeDasharray="2 3" />
          <text
            x={anchor.x + 10}
            y={anchor.y - 8}
            fill="#ffb020"
            fontFamily="'IBM Plex Mono', monospace"
            fontSize="9"
            fontWeight="600"
            letterSpacing="0.1em"
          >
            #1
          </text>
          <line
            x1={anchor.x + Math.sign(tailDx) * 4}
            y1={anchor.y + Math.sign(tailDy) * 4}
            x2={anchor.x + tailDx}
            y2={anchor.y + tailDy}
            stroke="#ffb020"
            strokeWidth="1.2"
            strokeDasharray="2 2"
            markerEnd="url(#lrc-arr)"
          />
          <text
            x={anchor.x + tailDx + (Math.sign(tailDx) * 6 || 0)}
            y={anchor.y + tailDy + (Math.sign(tailDy) * 6 || -5)}
            fill="rgba(255,176,32,0.7)"
            fontFamily="'IBM Plex Mono', monospace"
            fontSize="8"
            letterSpacing="0.1em"
          >
            {direction === "cw" ? "CLOCKWISE" : "COUNTER-CW"}
          </text>
        </g>
      )}

      {/* Keyboard */}
      <rect x="240" y="296" width="220" height="14" rx="2" fill="#11131a" stroke="rgba(255,255,255,0.08)" />
      <g fill="rgba(255,255,255,0.06)">
        {Array.from({ length: 21 }, (_, i) => (
          <rect key={`k-${i}`} x={246 + i * 10} y="300" width="8" height="5" />
        ))}
      </g>

      {/* Coffee mug */}
      <g opacity="0.75">
        <ellipse cx="580" cy="286" rx="14" ry="4" fill="#0d0f14" />
        <rect x="566" y="270" width="28" height="18" rx="2" fill="#1a1720" />
        <ellipse cx="580" cy="270" rx="14" ry="3" fill="#2a180c" />
      </g>
    </svg>
  );
}
