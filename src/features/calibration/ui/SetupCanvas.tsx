import { memo, type MouseEvent, type PointerEvent } from "react";

import type { LedSegmentKey } from "../model/contracts";
import type { Corner, LedRef } from "../model/startPoint";
import type { StageLayout } from "./stageGeometry";
import { SCREEN_STOPS, VIEW_H, VIEW_W } from "./stageGeometry";
import styles from "./SetupCanvas.module.css";

interface SetupCanvasProps {
  layout: StageLayout;
  /** First run: the screen shows dimmed and nothing is placed yet. */
  empty: boolean;
  /** The strip has a gap for the monitor's stand; only then is the stand drawn. */
  stand: boolean;
  /** Keys the flow's entrance: it draws itself again only when LED #1 or the direction changes. */
  flowKey: string;
  onPickLed: (led: LedRef) => void;
  onPickCorner: (corner: Corner) => void;
  onPickEnd: (end: "A" | "B") => void;
  /** The edge under the pointer, for the stage to light it and its number. */
  onHoverEdge: (edge: LedSegmentKey | null) => void;
}

const EDGE_ORDER: readonly LedSegmentKey[] = ["top", "right", "bottom", "left"];

/**
 * The screen, its LEDs and the way the light runs. Static: the strip shows the chase, so the
 * canvas never re-renders per frame (a per-frame render replaced the element under the pointer and
 * lost clicks), and hover is CSS on the stage's `data-active`, not a render. Picks and hover go
 * through one listener each.
 */
export const SetupCanvas = memo(function SetupCanvas({
  layout,
  empty,
  stand,
  flowKey,
  onPickLed,
  onPickCorner,
  onPickEnd,
  onHoverEdge,
}: SetupCanvasProps) {
  const { frame: f, pts, rings, first, track, flow, head, tail, firstCorner } = layout;
  const startKey = first ? `${first.edge}:${first.k}` : "";

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const target = (event.target as Element).closest<SVGElement>("[data-pick]");
    if (!target || empty) return;
    const [kind, id] = (target.dataset.pick ?? "").split("|");
    if (kind === "corner") onPickCorner(id as Corner);
    else if (kind === "end") onPickEnd(id as "A" | "B");
    else if (kind === "led") {
      const p = pts[Number(id)];
      if (p) onPickLed({ edge: p.edge, k: p.k });
    }
  };
  const onPointerOver = (event: PointerEvent<SVGSVGElement>) => {
    const edge = (event.target as Element).closest<SVGElement>("[data-edge]")?.dataset.edge;
    onHoverEdge((edge as LedSegmentKey | undefined) ?? null);
  };

  const cx = f.x + f.w / 2;
  const bottom = f.y + f.h;

  return (
    // Pointer-only: a few thousand LED buttons would bury the page for a screen
    // reader, and the first-LED chip reaches every place a person can name.
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      aria-hidden
      className={styles.canvas}
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerLeave={() => onHoverEdge(null)}
    >
      <defs>
        <linearGradient id="setup-screen" x1="0" x2="1" y1="0" y2="1">
          {SCREEN_STOPS.map(([at, color]) => (
            <stop key={at} offset={at} stopColor={color} />
          ))}
        </linearGradient>
        <linearGradient id="setup-glass" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".09" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="setup-stand" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0a0c10" />
          <stop offset="1" stopColor="#1a1e26" />
        </linearGradient>
      </defs>

      {stand && (
        <g className={styles.stand}>
          <path d={`M${cx - 13} ${bottom + 4} L${cx + 13} ${bottom + 4} L${cx + 17} ${bottom + 32} L${cx - 17} ${bottom + 32} Z`} fill="url(#setup-stand)" />
          <rect x={cx - 58} y={bottom + 31} width="116" height="6" rx="3" className={styles.foot} />
        </g>
      )}
      <rect x={f.x - 5} y={f.y - 5} width={f.w + 10} height={f.h + 10} rx="9" className={styles.bezel} />
      <path d={`M${f.x + 4} ${f.y - 4.5} H${f.x + f.w - 4}`} className={styles.bezelEdge} />
      {/* A dark panel with the picture turned down: the strip's light and the amber line are what
          this page is about, and a full-bright picture drowned both. */}
      <rect x={f.x} y={f.y} width={f.w} height={f.h} rx="4" className={styles.panel} />
      <rect
        x={f.x}
        y={f.y}
        width={f.w}
        height={f.h}
        rx="4"
        fill="url(#setup-screen)"
        className={empty ? `${styles.picture} ${styles.isEmpty}` : styles.picture}
      />
      <rect x={f.x} y={f.y} width={f.w} height={f.h} rx="4" fill="url(#setup-glass)" />

      {!empty &&
        track.map((d, i) => (
          <path key={i} d={d} className={styles.track} />
        ))}

      {!empty && flow && (
        <g key={`flow:${flowKey}`} className={styles.flow}>
          {tail && <circle cx={tail.x} cy={tail.y} r="2.6" className={styles.tail} />}
          <path d={flow} pathLength={1} className={styles.flowLine} />
          {head && (
            <path
              d="M-4.5 -4 L1.5 0 L-4.5 4"
              transform={`translate(${head.x} ${head.y}) rotate(${head.angle})`}
              className={styles.head}
            />
          )}
        </g>
      )}

      {!empty &&
        EDGE_ORDER.map((edge) => {
          const edgePts = pts.map((p, i) => [p, i] as const).filter(([p]) => p.edge === edge);
          if (!edgePts.length) return null;
          // Keyed by edge: an edge switched on mounts and fades in once; count changes do not re-run it.
          return (
            <g key={edge} data-edge={edge} className={styles.edge}>
              {edgePts.map(([p, i]) => (
                <g key={i} data-pick={`led|${i}`} className={styles.led}>
                  <circle cx={p.x} cy={p.y} r="5.5" className={styles.hit} />
                  <circle cx={p.x} cy={p.y} r="2.7" fill={p.color} className={styles.dot} />
                </g>
              ))}
            </g>
          );
        })}

      {!empty &&
        rings.map((r) => (
          <g key={`${r.kind}${r.id}`} data-pick={`${r.kind}|${r.id}`} className={r.kind === "end" ? `${styles.ring} ${styles.isEnd}` : styles.ring}>
            <circle cx={r.cx} cy={r.cy} r="11" className={styles.hit} />
            <circle cx={r.cx} cy={r.cy} r="5.5" className={styles.ringMark} />
          </g>
        ))}

      {!empty && first && (
        <g
          key={`first:${startKey}`}
          transform={`translate(${first.x} ${first.y})`}
          data-pick={firstCorner ? `corner|${firstCorner}` : undefined}
          className={firstCorner ? `${styles.first} ${styles.flips}` : styles.first}
        >
          <circle r="11" className={styles.hit} />
          <circle r="6.5" className={styles.ripple} />
          <circle r="6.5" className={styles.firstRing} />
          {firstCorner && <path d="M2.4 -1.6 A2.9 2.9 0 1 0 2.9 0.9 M2.6 -3.6 V-1.4 H0.4" className={styles.flipGlyph} />}
        </g>
      )}
    </svg>
  );
});
