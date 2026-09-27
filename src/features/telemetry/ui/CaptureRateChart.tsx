import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { CAPTURE_TARGET_FPS_ABSENT, type CaptureFpsSample } from "@/shared/contracts/telemetry";
import styles from "./CaptureRateChart.module.css";

export const CHART_WINDOW_MS = 5 * 60 * 1000;
/** Rust samples once a second; a wider step means the lights were off, and is drawn as a gap. */
const GAP_MS = 2500;
const VIEW_W = 300;
const VIEW_H = 100;
/** Head room over the highest value, so a line at the ceiling is not drawn on the edge. */
const HEADROOM = 1.15;

interface Plotted {
  sample: CaptureFpsSample;
  x: number;
  y: number;
  targetY: number;
}

export interface ChartModel {
  points: Plotted[];
  /** Each run of samples with no gap, as SVG path data. */
  line: string;
  target: string;
  lastTarget: number | null;
  targetLabelY: number | null;
  avg: number | null;
  min: number | null;
}

function pathOf(runs: { x: number; y: number }[][]): string {
  return runs
    .filter((run) => run.length > 0)
    .map((run) => run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(""))
    .join("");
}

/** Pure, so the drawing is tested without a layout engine. */
export function chartModel(samples: CaptureFpsSample[], endMs: number): ChartModel {
  const startMs = endMs - CHART_WINDOW_MS;
  const inWindow = samples.filter((s) => s.epochMs >= startMs && s.epochMs <= endMs);
  const top = Math.max(1, ...inWindow.map((s) => Math.max(s.fps, s.targetFps))) * HEADROOM;
  const x = (ms: number) => ((ms - startMs) / CHART_WINDOW_MS) * VIEW_W;
  const y = (fps: number) => VIEW_H - (fps / top) * VIEW_H;

  const points: Plotted[] = [];
  const lineRuns: { x: number; y: number }[][] = [];
  const targetRuns: { x: number; y: number }[][] = [];
  let lineRun: { x: number; y: number }[] = [];
  let targetRun: { x: number; y: number }[] = [];
  let previous: CaptureFpsSample | null = null;
  for (const sample of inWindow) {
    const step = previous ? sample.epochMs - previous.epochMs : Infinity;
    // A step back is a clock jump, not a reordering: Rust keeps insertion order.
    if (step > GAP_MS || step <= 0) {
      lineRun = [];
      targetRun = [];
      lineRuns.push(lineRun);
      targetRuns.push(targetRun);
    }
    const point = { sample, x: x(sample.epochMs), y: y(sample.fps), targetY: y(sample.targetFps) };
    points.push(point);
    lineRun.push({ x: point.x, y: point.y });
    if (sample.targetFps > CAPTURE_TARGET_FPS_ABSENT) targetRun.push({ x: point.x, y: point.targetY });
    previous = sample;
  }

  const last = inWindow[inWindow.length - 1] ?? null;
  const fps = inWindow.map((s) => s.fps);
  return {
    points,
    line: pathOf(lineRuns),
    target: pathOf(targetRuns),
    lastTarget: last && last.targetFps > CAPTURE_TARGET_FPS_ABSENT ? last.targetFps : null,
    targetLabelY: last && last.targetFps > CAPTURE_TARGET_FPS_ABSENT ? y(last.targetFps) : null,
    avg: fps.length > 0 ? fps.reduce((sum, v) => sum + v, 0) / fps.length : null,
    min: fps.length > 0 ? Math.min(...fps) : null,
  };
}

/** Index of the sample nearest `x` (view units), or -1 when the nearest is across a gap. */
export function nearestPoint(points: Plotted[], x: number): number {
  const xs = points.map((p) => p.x);
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  const distance = (i: number) => Math.abs((xs[i] ?? Infinity) - x);
  const best = lo > 0 && distance(lo - 1) < distance(lo) ? lo - 1 : lo;
  const reach = (GAP_MS / CHART_WINDOW_MS) * VIEW_W;
  return distance(best) <= reach ? best : -1;
}

interface CaptureRateChartProps {
  samples: CaptureFpsSample[];
  /** When the history was read; the time axis ends here, so time with the lights off shows as a gap. */
  endMs: number;
}

/**
 * The last five minutes of capture rate under the "Screen capture" row, the rate capture was asked
 * for dashed behind it. Hover or the arrow keys read one second back as its time and rate; the
 * crosshair and bubble move by style, not by render, since a pointer fires faster than React should.
 */
export function CaptureRateChart({ samples, endMs }: CaptureRateChartProps) {
  const { t, i18n } = useTranslation();
  const model = useMemo(() => chartModel(samples, endMs), [samples, endMs]);
  const time = useMemo(
    () => new Intl.DateTimeFormat(i18n?.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    [i18n?.language],
  );

  const plotRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  /** What is being read: a place under the pointer, or the second the keys landed on. A new
   *  reading every two seconds moves the line under both, so the bubble is placed again from it. */
  const anchorRef = useRef<{ x: number } | { epochMs: number } | null>(null);

  const readout = (point: Plotted) =>
    `${time.format(point.sample.epochMs)} · ${t("telemetry:fps", { fps: Math.round(point.sample.fps) })}`;

  const show = (index: number, announce: boolean) => {
    const plot = plotRef.current;
    const cursor = cursorRef.current;
    const dot = dotRef.current;
    const bubble = bubbleRef.current;
    if (!plot || !cursor || !dot || !bubble) return;
    const point = model.points[index];
    if (!point) {
      plot.removeAttribute("data-reading");
      return;
    }
    const width = plot.clientWidth;
    const left = (point.x / VIEW_W) * width;
    const top = (point.y / VIEW_H) * plot.clientHeight;
    cursor.style.transform = `translateX(${left}px)`;
    dot.style.transform = `translate(${left}px, ${top}px)`;
    bubble.textContent = readout(point);
    // Kept inside the plot so it never pokes past the readout's edge; a bubble wider than the plot
    // starts at its left edge.
    const room = Math.max(0, width - bubble.offsetWidth);
    bubble.style.transform = `translateX(${Math.max(0, Math.min(left - bubble.offsetWidth / 2, room))}px)`;
    plot.setAttribute("data-reading", "");
    if (announce && liveRef.current) liveRef.current.textContent = readout(point);
  };

  const anchoredIndex = () => {
    const anchor = anchorRef.current;
    if (anchor === null) return -1;
    return "x" in anchor
      ? nearestPoint(model.points, anchor.x)
      : model.points.findIndex((p) => p.sample.epochMs === anchor.epochMs);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-place on a new reading only
  useEffect(() => {
    if (anchorRef.current !== null) show(anchoredIndex(), false);
  }, [model]);

  // A resize moves every point under a bubble placed in pixels. `show` is read through a ref so the
  // observer is set up once, not on every reading.
  const showRef = useRef(show);
  showRef.current = show;
  const anchoredRef = useRef(anchoredIndex);
  anchoredRef.current = anchoredIndex;
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (anchorRef.current !== null) showRef.current(anchoredRef.current(), false);
    });
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    anchorRef.current = { x: ((event.clientX - rect.left) / rect.width) * VIEW_W };
    show(anchoredIndex(), false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = model.points.length - 1;
    if (last < 0) return;
    const at = anchoredIndex();
    const current = at < 0 ? last : at;
    const next =
      event.key === "ArrowLeft" ? Math.max(0, current - 1)
      : event.key === "ArrowRight" ? Math.min(last, current + 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (event.key === "Escape") {
      hide();
      return;
    }
    const point = next === null ? undefined : model.points[next];
    if (next === null || !point) return;
    event.preventDefault();
    anchorRef.current = { epochMs: point.sample.epochMs };
    show(next, true);
  };

  function hide() {
    anchorRef.current = null;
    show(-1, false);
  }

  const empty = model.points.length === 0;
  const summary =
    model.avg !== null && model.min !== null
      ? t("telemetry:historySummary", { avg: Math.round(model.avg), min: Math.round(model.min) })
      : t("telemetry:historyEmpty");

  return (
    <div className={styles.chart} data-testid="telemetry-history">
      <div
        ref={plotRef}
        className={styles.plot}
        tabIndex={empty ? undefined : 0}
        role="img"
        aria-label={
          empty
            ? t("telemetry:historyEmpty")
            : t("telemetry:historyLabel", { avg: Math.round(model.avg ?? 0), min: Math.round(model.min ?? 0) })
        }
        onPointerMove={empty ? undefined : onPointerMove}
        onPointerLeave={hide}
        onKeyDown={onKeyDown}
        onBlur={hide}
      >
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" aria-hidden="true">
          {model.target && <path className={styles.target} d={model.target} />}
          {model.line && <path className={styles.line} d={model.line} />}
        </svg>
        {model.lastTarget !== null && model.targetLabelY !== null && (
          <span className={styles.targetLabel} style={{ top: `${model.targetLabelY}%` }} aria-hidden="true">
            {t("telemetry:historyTarget", { fps: Math.round(model.lastTarget) })}
          </span>
        )}
        <div ref={cursorRef} className={styles.cursor} aria-hidden="true" />
        <div ref={dotRef} className={styles.dot} aria-hidden="true" />
        <div ref={bubbleRef} className={styles.bubble} aria-hidden="true" />
      </div>
      <div className={styles.axis} aria-hidden="true">
        <span>{t("telemetry:historyStart")}</span>
        <span className={styles.summary}>{summary}</span>
        <span>{t("telemetry:historyEnd")}</span>
      </div>
      <span ref={liveRef} className="sr-only" aria-live="polite" />
    </div>
  );
}
