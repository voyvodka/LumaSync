/**
 * ZoneDeriveOverlay — SVG overlay showing derived zone edge lines and LED count badges.
 *
 * Renders colored edge lines along each TV side with LED count badges.
 * Floating action bar with Confirm / Discard Preview buttons.
 *
 * ZONE-02 / ZONE-03 — Phase 19 Plan 02
 */

import { useTranslation } from "react-i18next";
import type { TvAnchorPlacement } from "../../../../shared/contracts/roomMap";
import type { ZoneDeriveResult } from "./deriveZones";

// ---------------------------------------------------------------------------
// Edge palette (per UI-SPEC Zone Edge Palette)
// ---------------------------------------------------------------------------

const EDGE_COLOR: Record<"top" | "right" | "bottom" | "left", string> = {
  top: "#10b981",     // emerald-500
  bottom: "#f59e0b",  // amber-500
  left: "#3b82f6",    // blue-500
  right: "#a855f7",   // purple-500
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ZoneDeriveOverlayProps {
  result: ZoneDeriveResult;
  tv: TvAnchorPlacement;
  pxPerMeter: number;
  onConfirm: () => void;
  onDiscard: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ZoneDeriveOverlay({
  result,
  tv,
  pxPerMeter,
  onConfirm,
  onDiscard,
}: ZoneDeriveOverlayProps) {
  const { t } = useTranslation("common");

  // TV bounding box in pixels
  const leftPx = (tv.x - tv.width / 2) * pxPerMeter;
  const rightPx = (tv.x + tv.width / 2) * pxPerMeter;
  const topPx = (tv.y - tv.height / 2) * pxPerMeter;
  const bottomPx = (tv.y + tv.height / 2) * pxPerMeter;

  const tvWidthPx = rightPx - leftPx;
  const tvHeightPx = bottomPx - topPx;

  // Derive edge geometry for lines and fill bands
  const INSET = 8; // px inset from edge towards TV center

  type EdgeDef = {
    edge: "top" | "right" | "bottom" | "left";
    // Line endpoints
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    // Fill band rect
    fillX: number;
    fillY: number;
    fillW: number;
    fillH: number;
    // Badge anchor
    midX: number;
    midY: number;
  };

  const edgeDefs: EdgeDef[] = [
    {
      edge: "top",
      x1: leftPx,   y1: topPx,
      x2: rightPx,  y2: topPx,
      fillX: leftPx, fillY: topPx, fillW: tvWidthPx, fillH: INSET,
      midX: leftPx + tvWidthPx / 2, midY: topPx - 12,
    },
    {
      edge: "bottom",
      x1: leftPx,  y1: bottomPx,
      x2: rightPx, y2: bottomPx,
      fillX: leftPx, fillY: bottomPx - INSET, fillW: tvWidthPx, fillH: INSET,
      midX: leftPx + tvWidthPx / 2, midY: bottomPx + 16,
    },
    {
      edge: "left",
      x1: leftPx,  y1: topPx,
      x2: leftPx,  y2: bottomPx,
      fillX: leftPx, fillY: topPx, fillW: INSET, fillH: tvHeightPx,
      midX: leftPx - 4, midY: topPx + tvHeightPx / 2,
    },
    {
      edge: "right",
      x1: rightPx, y1: topPx,
      x2: rightPx, y2: bottomPx,
      fillX: rightPx - INSET, fillY: topPx, fillW: INSET, fillH: tvHeightPx,
      midX: rightPx + 4, midY: topPx + tvHeightPx / 2,
    },
  ];

  // Build a quick ledCount lookup from result.segments (aggregate per edge)
  const edgeLedCount: Record<string, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const seg of result.segments) {
    edgeLedCount[seg.edge] = (edgeLedCount[seg.edge] ?? 0) + seg.ledCount;
  }

  // Edge label names for badges
  const EDGE_LABELS: Record<"top" | "right" | "bottom" | "left", string> = {
    top: t("roomMap.edges.top"),
    right: t("roomMap.edges.right"),
    bottom: t("roomMap.edges.bottom"),
    left: t("roomMap.edges.left"),
  };

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 20 }}
      aria-label={t("roomMap.zones.deriveSuccess")}
    >
      {/* SVG overlay for edge lines and fill bands */}
      <svg
        className="absolute inset-0 w-full h-full overflow-visible"
        style={{ zIndex: 20 }}
      >
        {edgeDefs.map(({ edge, x1, y1, x2, y2, fillX, fillY, fillW, fillH }) => {
          const color = EDGE_COLOR[edge];
          const count = edgeLedCount[edge] ?? 0;
          if (count === 0) return null;
          return (
            <g key={edge}>
              {/* Semi-transparent fill band */}
              <rect
                x={fillX}
                y={fillY}
                width={fillW}
                height={fillH}
                fill={color}
                opacity={0.15}
              />
              {/* Edge line */}
              <line
                data-testid={`zone-edge-${edge}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={color}
                strokeWidth="2"
              />
            </g>
          );
        })}
      </svg>

      {/* Badge labels rendered as HTML (foreignObject causes issues in some WebViews) */}
      {edgeDefs.map(({ edge, midX, midY }) => {
        const count = edgeLedCount[edge] ?? 0;
        if (count === 0) return null;
        const color = EDGE_COLOR[edge];
        return (
          <div
            key={`badge-${edge}`}
            className="absolute rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white pointer-events-none select-none"
            style={{
              left: midX,
              top: midY,
              transform: "translate(-50%, -50%)",
              backgroundColor: color,
              zIndex: 21,
            }}
          >
            {EDGE_LABELS[edge]}: {count}
          </div>
        );
      })}

      {/* Floating action bar */}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-2 pointer-events-auto"
        style={{ zIndex: 30 }}
      >
        <button
          className="bg-slate-800 text-white hover:bg-slate-900 dark:bg-zinc-700 dark:hover:bg-zinc-600 px-3 py-1 rounded-md text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
          onClick={onConfirm}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        >
          {t("roomMap.zones.confirmDeriveButton")}
        </button>
        <button
          className="text-slate-500 hover:text-slate-700 dark:text-zinc-400 px-3 py-1 rounded-md text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
          onClick={onDiscard}
        >
          {t("roomMap.zones.cancelDeriveButton")}
        </button>
      </div>
    </div>
  );
}
