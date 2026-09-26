import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { LedSegmentKey } from "../model/contracts";
import {
  countBounds,
  countOf,
  EDGES,
  isLinked,
  keyForEdge,
  type CountKey,
  type DisplayAspect,
  type LayoutDraft,
  type LinkedPair,
} from "../model/ledLayout";
import { holdStart, restoreStart, type Corner, type LedRef, type StartPoint } from "../model/startPoint";
import { CountChip } from "./CountChip";
import { SetupCanvas } from "./SetupCanvas";
import { computeStage, frameFor, VIEW_H, VIEW_W, type ChipAnchor } from "./stageGeometry";
import styles from "./SetupStage.module.css";

interface SetupStageProps {
  draft: LayoutDraft;
  start: StartPoint;
  display: DisplayAspect;
  empty: boolean;
  /** The split a total being typed would make; shown instead of the counts, not editable. */
  preview?: LayoutDraft | null;
  onCount: (key: CountKey, value: number) => void;
  onEdgeToggle: (edge: LedSegmentKey, lit: boolean) => void;
  onStandToggle: (on: boolean) => void;
  onChain: (pair: LinkedPair) => void;
  onPickLed: (led: LedRef) => void;
  onPickCorner: (corner: Corner) => void;
  onPickEnd: (end: "A" | "B") => void;
  /** Laid over the stage, centred: the first-run question. */
  children?: ReactNode;
}

const EDGE_LABEL = {
  top: "calibration:setup.edge.top",
  right: "calibration:setup.edge.right",
  bottom: "calibration:setup.edge.bottom",
  left: "calibration:setup.edge.left",
} as const;
const PAIR_LABEL = { tb: "calibration:setup.edge.tb", lr: "calibration:setup.edge.lr" } as const;
const ADD_LABEL = {
  top: "calibration:setup.add.top",
  right: "calibration:setup.add.right",
  bottom: "calibration:setup.add.bottom",
  left: "calibration:setup.add.left",
} as const;

const pairOf = (edge: LedSegmentKey): LinkedPair => (edge === "top" || edge === "bottom" ? "tb" : "lr");
const OTHER: Record<LedSegmentKey, LedSegmentKey> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const otherOf = (edge: LedSegmentKey) => OTHER[edge];
/** Past this the monitor only gets bigger than the numbers around it, and the page emptier. */
const MAX_SCALE = 1.5;

/** The canvas at the size the space allows, with its numbers laid over it in the same coordinates. */
export function SetupStage(props: SetupStageProps) {
  const { draft: saved, start: savedStart, display, empty, preview, onCount, onEdgeToggle, onStandToggle, onChain, children } = props;
  const draft = preview ?? saved;
  const { t } = useTranslation();
  const fitRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    // Measures the space left once the dock's room is taken off, not the padded box.
    const box = fitRef.current;
    if (!box) return;
    const fit = () => setScale(Math.max(0.5, Math.min(MAX_SCALE, box.clientWidth / VIEW_W, box.clientHeight / VIEW_H)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const shape = useMemo(() => ({ counts: draft.counts, gap: draft.gap }), [draft.counts, draft.gap]);
  // The preview keeps LED #1 where applying would: an end or an edge's last LED (a corner) stays
  // that as the counts change, the same rule the edit itself uses.
  const start = useMemo(
    () => (preview ? restoreStart(shape, savedStart, holdStart({ counts: saved.counts, gap: saved.gap }, savedStart)) : savedStart),
    [preview, shape, savedStart, saved.counts, saved.gap],
  );
  const frame = useMemo(() => frameFor(display), [display]);
  const layout = useMemo(() => computeStage(shape, start, frame), [shape, start, frame]);

  // Hover and focus light an edge through an attribute on the stage, read by CSS: a state here
  // would re-render every LED on each pointer move between edges.
  const activate = useCallback((edges: readonly LedSegmentKey[], on: boolean) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (on && edges.length) stage.dataset.active = edges.join(" ");
    else delete stage.dataset.active;
  }, []);
  const edgesOf = useCallback(
    (edge: LedSegmentKey): LedSegmentKey[] => (isLinked(draft, pairOf(edge)) && draft.counts[otherOf(edge)] > 0 ? [edge, otherOf(edge)] : [edge]),
    [draft],
  );
  const onHoverEdge = useCallback(
    (edge: LedSegmentKey | null) => activate(edge ? edgesOf(edge) : [], edge !== null),
    [activate, edgesOf],
  );

  const lit = EDGES.filter((e) => draft.counts[e] > 0);
  const at = (a: ChipAnchor) => ({ left: `${(a.x / VIEW_W) * 100}%`, top: `${(a.y / VIEW_H) * 100}%` });

  const chip = (a: ChipAnchor) => {
    switch (a.kind) {
      case "edge": {
        const key = keyForEdge(draft, a.edge);
        const pair = pairOf(a.edge);
        const pairLit = draft.counts[otherOf(a.edge)] > 0;
        const edges = edgesOf(a.edge);
        const { min, max } = countBounds(draft, key, display);
        return (
          <CountChip
            key={a.edge}
            style={at(a)}
            label={t(key === "tb" || key === "lr" ? PAIR_LABEL[key] : EDGE_LABEL[a.edge])}
            value={countOf(draft, key)}
            min={min}
            max={max}
            edges={edges}
            link={pairLit ? { linked: isLinked(draft, pair), onToggle: () => onChain(pair) } : undefined}
            onRemove={lit.length > 1 ? () => onEdgeToggle(a.edge, false) : undefined}
            removeLabel={t("calibration:setup.remove")}
            onChange={(v) => onCount(key, v)}
            onActive={(on) => activate(edges, on)}
          />
        );
      }
      case "side": {
        // Each side of the stand shows its own run; typing one sets both, as the stand sits in the middle.
        const key = keyForEdge(draft, "bottom");
        const edges: LedSegmentKey[] = key === "tb" ? ["top", "bottom"] : ["bottom"];
        return (
          <CountChip
            key={`side-${a.side}`}
            style={at(a)}
            edges={edges}
            label={t(a.side === "right" ? "calibration:setup.edge.standRight" : "calibration:setup.edge.standLeft")}
            value={a.count}
            min={1}
            max={Math.floor(countBounds(draft, key, display).max / 2)}
            onChange={(v) => onCount(key, v * 2)}
            onActive={(on) => activate(edges, on)}
          />
        );
      }
      case "gap": {
        const { min, max } = countBounds(draft, "gap", display);
        return (
          <CountChip
            key="gap"
            style={at(a)}
            edges={["bottom"]}
            icon={<StandGlyph />}
            label={t("calibration:setup.edge.gap")}
            value={draft.gap}
            min={min}
            max={max}
            onRemove={() => onStandToggle(false)}
            removeLabel={t("calibration:setup.removeStand")}
            onChange={(v) => onCount("gap", v)}
            onActive={() => {}}
          />
        );
      }
      case "ghost":
        return (
          <button
            key={`ghost-${a.edge}`}
            type="button"
            style={at(a)}
            onClick={() => onEdgeToggle(a.edge, true)}
            aria-label={t(ADD_LABEL[a.edge])}
            title={t(ADD_LABEL[a.edge])}
            className={styles.ghost}
          >
            +
          </button>
        );
      case "addStand":
        return (
          <button
            key="addStand"
            type="button"
            style={at(a)}
            onClick={() => onStandToggle(true)}
            aria-label={t("calibration:setup.add.stand")}
            title={t("calibration:setup.add.stand")}
            className={`${styles.ghost} ${styles.addStand}`}
          >
            <StandGlyph />+
          </button>
        );
    }
  };

  const f = layout.frame;
  // The light the strip throws on the wall, around the screen: one blurred layer, composited once.
  const halo: CSSProperties = {
    left: `${((f.x - 26) / VIEW_W) * 100}%`,
    top: `${((f.y - 26) / VIEW_H) * 100}%`,
    width: `${((f.w + 52) / VIEW_W) * 100}%`,
    height: `${((f.h + 52) / VIEW_H) * 100}%`,
  };

  return (
    <div className={styles.box}>
      <div ref={fitRef} className={styles.fit} aria-hidden />
      <div
        ref={stageRef}
        className={preview ? `${styles.stage} ${styles.isPreviewing}` : styles.stage}
        style={{ width: VIEW_W * scale, height: VIEW_H * scale }}
        // What only matters while the pointer is here (where LED #1 can go, adding a stand) waits for it.
        onPointerEnter={(e) => {
          e.currentTarget.dataset.pointer = "";
        }}
        onPointerLeave={(e) => {
          delete e.currentTarget.dataset.pointer;
        }}
      >
        {!empty && <div className={styles.halo} style={halo} aria-hidden />}
        <SetupCanvas
          layout={layout}
          empty={empty}
          stand={draft.gap > 0}
          flowKey={`${start.led.edge}:${start.led.k}:${start.direction}`}
          onPickLed={props.onPickLed}
          onPickCorner={props.onPickCorner}
          onPickEnd={props.onPickEnd}
          onHoverEdge={onHoverEdge}
        />
        {!empty && layout.chips.map(chip)}
        {children}
      </div>
    </div>
  );
}

function StandGlyph() {
  return (
    <svg viewBox="0 0 16 12" aria-hidden className={styles.glyph}>
      <path d="M1 2h5M10 2h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.5 2" />
      <path d="M6.5 2v6M9.5 2v6M4 10h8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}
