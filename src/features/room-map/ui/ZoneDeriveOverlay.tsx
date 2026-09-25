/**
 * ZoneDeriveOverlay — the "LED counts from the map" preview: coloured edge
 * lines along each TV side with LED count badges, drawn in map space.
 * `ZoneDeriveActionBar` is its Confirm / Discard pair, drawn in screen space.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { tvFootprintBounds, type ZoneDeriveResult } from "../model/deriveZones";

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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ZoneDeriveOverlay({
  result,
  tv,
  pxPerMeter,
}: ZoneDeriveOverlayProps) {
  const { t } = useTranslation();

  const bounds = tvFootprintBounds(tv);
  const leftPx = bounds.left * pxPerMeter;
  const rightPx = bounds.right * pxPerMeter;
  const topPx = bounds.top * pxPerMeter;
  const bottomPx = bounds.bottom * pxPerMeter;

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
    top: t("roomMap:edges.top"),
    right: t("roomMap:edges.right"),
    bottom: t("roomMap:edges.bottom"),
    left: t("roomMap:edges.left"),
  };

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 20 }}
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

    </div>
  );
}

interface ZoneDeriveActionBarProps {
  onConfirm: () => void;
  onDiscard: () => void;
}

/**
 * Rendered outside the canvas's pan/zoom layer, so it stays on screen at any
 * zoom — inside it the bar could sit below the clip, and focusing it scrolled
 * the `overflow: hidden` canvas with no way back.
 */
export function ZoneDeriveActionBar({ onConfirm, onDiscard }: ZoneDeriveActionBarProps) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Deliberate: the preview is a confirm step, so focus belongs on its primary
  // action the moment it opens. Not `autoFocus`, which scrolls to the target.
  useEffect(() => {
    confirmRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      role="group"
      aria-label={t("roomMap:deriveCounts.previewLabel")}
      className="absolute bottom-16 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line-2 bg-panel/95 p-1.5 shadow-lg"
      style={{ zIndex: 30 }}
    >
      <span className="whitespace-nowrap px-1.5 text-[11px] text-ink-dim">{t("roomMap:deriveCounts.previewLabel")}</span>
      <button
        ref={confirmRef}
        type="button"
        className="min-h-8 whitespace-nowrap rounded-md bg-amber px-3 py-1 text-[11px] font-semibold text-bg hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        onClick={onConfirm}
      >
        {t("roomMap:deriveCounts.confirm")}
      </button>
      <button
        type="button"
        className="min-h-8 whitespace-nowrap rounded-md px-3 py-1 text-[11px] font-semibold text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
        onClick={onDiscard}
      >
        {t("roomMap:deriveCounts.cancel")}
      </button>
    </div>
  );
}
