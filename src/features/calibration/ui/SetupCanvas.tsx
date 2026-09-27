import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { usePresence } from "@/shared/lib/usePresence";

import type { LedSegmentKey } from "../model/contracts";
import type { Corner, LedRef } from "../model/startPoint";
import type { Frame, Point, StageLayout } from "./stageGeometry";
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
/** Past the edge's and the stand's fade-out. */
const EXIT_MS = 300;
/** The monitor's change of shape on a display switch; `--lm-dur-base`. */
const MORPH_MS = 250;
const MORPH_TRANSITION = "transform var(--lm-dur-base) var(--lm-ease-out)";

const sameFrame = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * FLIP from the previous display's shape: every moving part starts where it was drawn and eases to
 * where it is now, on `transform` alone — one style change per part, no render per frame. The
 * monitor stretches; the LEDs, LED #1 and the stand travel.
 */
function morphFrom(svg: SVGSVGElement, prev: StageLayout, next: StageLayout) {
  // Before the reflow below, so the stage's numbers and halo take their transition from it too.
  svg.setAttribute("data-morphing", "true");
  const a = prev.frame;
  const b = next.frame;
  const sx = a.w / b.w;
  const sy = a.h / b.h;
  const moves: [Element, string][] = [];
  const frame = svg.querySelector("[data-morph=frame]");
  if (frame) moves.push([frame, `translate(${a.x - b.x * sx}px, ${a.y - b.y * sy}px) scale(${sx}, ${sy})`]);
  const stand = svg.querySelector("[data-morph=stand]");
  if (stand) moves.push([stand, `translate(${a.x + a.w / 2 - (b.x + b.w / 2)}px, ${a.y + a.h - (b.y + b.h)}px)`]);
  const first = svg.querySelector("[data-morph=first]");
  if (first && prev.first && next.first) {
    moves.push([first, `translate(${prev.first.x - next.first.x}px, ${prev.first.y - next.first.y}px)`]);
  }
  const was = new Map(prev.pts.map((p) => [`${p.edge}:${p.k}`, p]));
  svg.querySelectorAll<SVGGElement>("[data-led]").forEach((el) => {
    const now = next.pts[Number(el.dataset.led)];
    const then = now && was.get(`${now.edge}:${now.k}`);
    if (now && then) moves.push([el, `translate(${then.x - now.x}px, ${then.y - now.y}px)`]);
  });
  for (const [el, transform] of moves) {
    const style = (el as SVGElement).style;
    style.transition = "none";
    style.transform = transform;
  }
  // Commit the starting point before easing away from it.
  svg.getBoundingClientRect();
  for (const [el] of moves) {
    const style = (el as SVGElement).style;
    style.transition = MORPH_TRANSITION;
    style.transform = "";
  }
}

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

  // A display switch changes the frame: the monitor morphs to the new shape, and the track and the
  // flow, which cannot morph (WebKit does not animate `d`), wait for it and then draw again.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const prevRef = useRef<StageLayout | null>(null);
  const [morph, setMorph] = useState(0);
  const [morphing, setMorphing] = useState(false);
  const morphTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = layout;
    if (!prev || !svgRef.current || empty || sameFrame(prev.frame, layout.frame) || prefersReducedMotion()) return;
    morphFrom(svgRef.current, prev, layout);
    setMorphing(true);
    setMorph((n) => n + 1);
    // A second switch mid-morph starts the wait over.
    if (morphTimer.current) clearTimeout(morphTimer.current);
    morphTimer.current = setTimeout(() => setMorphing(false), MORPH_MS);
  }, [layout, empty]);
  useEffect(
    () => () => {
      if (morphTimer.current) clearTimeout(morphTimer.current);
    },
    [],
  );

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
      ref={svgRef}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      aria-hidden
      data-morphing={morphing || undefined}
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

      <g data-morph="stand">
        <Stand shown={stand} cx={cx} bottom={bottom} />
      </g>
      <g data-morph="frame">
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
      </g>

      {!empty && !morphing && (
        <g key={`track:${morph}`} className={morph ? styles.trackBack : undefined}>
          {track.map((d, i) => (
            <path key={i} d={d} className={styles.track} />
          ))}
        </g>
      )}

      {!empty && !morphing && flow && (
        <g key={`flow:${flowKey}:${morph}`} className={styles.flow}>
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
        EDGE_ORDER.map((edge) => (
          // Keyed by edge: an edge switched on fades in once; count changes do not re-run it.
          <EdgeDots key={edge} edge={edge} dots={pts.map((p, i) => [p, i] as const).filter(([p]) => p.edge === edge)} />
        ))}

      {!empty &&
        rings.map((r) => (
          <g key={`${r.kind}${r.id}`} data-pick={`${r.kind}|${r.id}`} className={r.kind === "end" ? `${styles.ring} ${styles.isEnd}` : styles.ring}>
            <circle cx={r.cx} cy={r.cy} r="11" className={styles.hit} />
            <circle cx={r.cx} cy={r.cy} r="5.5" className={styles.ringMark} />
          </g>
        ))}

      {!empty && first && (
        <g data-morph="first">
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
        </g>
      )}
    </svg>
  );
});

/**
 * The edge's hover band: its LEDs joined, run by run, so the pointer stays on the edge between two
 * LEDs. Their hit circles leave gaps, and every gap used to drop the edge's highlight and bring it
 * back a moment later — a flicker along the strip. A stand gap is wider than any spacing and stays out.
 */
function bandOf(dots: readonly (readonly [Point, number])[]): string {
  const steps = dots.slice(1).map(([p], i) => Math.hypot(p.x - dots[i]![0].x, p.y - dots[i]![0].y));
  const spacing = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
  return dots
    .map(([p], i) => `${i === 0 || steps[i - 1]! > spacing * 1.6 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join("");
}

/** One edge's LEDs. Switched off, it fades out from where it was instead of vanishing. */
function EdgeDots({ edge, dots }: { edge: LedSegmentKey; dots: readonly (readonly [Point, number])[] }) {
  const lastRef = useRef(dots);
  if (dots.length) lastRef.current = dots;
  const { mounted, leaving } = usePresence(dots.length > 0, EXIT_MS);
  if (!mounted) return null;
  return (
    <g data-edge={edge} className={leaving ? `${styles.edge} ${styles.leaving}` : styles.edge}>
      <path d={bandOf(lastRef.current)} className={styles.band} />
      {lastRef.current.map(([p, i]) => (
        <g key={i} data-pick={leaving ? undefined : `led|${i}`} data-led={i} className={styles.led}>
          <circle cx={p.x} cy={p.y} r="5.5" className={styles.hit} />
          <circle cx={p.x} cy={p.y} r="2.7" fill={p.color} className={styles.dot} />
        </g>
      ))}
    </g>
  );
}

/** The monitor's stand, drawn only while the strip leaves a gap for it; it goes the way it came. */
function Stand({ shown, cx, bottom }: { shown: boolean; cx: number; bottom: number }) {
  const { mounted, leaving } = usePresence(shown, EXIT_MS);
  if (!mounted) return null;
  return (
    <g className={leaving ? `${styles.stand} ${styles.leaving}` : styles.stand}>
      <path d={`M${cx - 13} ${bottom + 4} L${cx + 13} ${bottom + 4} L${cx + 17} ${bottom + 32} L${cx - 17} ${bottom + 32} Z`} fill="url(#setup-stand)" />
      <rect x={cx - 58} y={bottom + 31} width="116" height="6" rx="3" className={styles.foot} />
    </g>
  );
}
