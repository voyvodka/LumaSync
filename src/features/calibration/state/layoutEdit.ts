import type { LedCalibrationConfig } from "../model/contracts";
import { draftFromCounts, type LayoutDraft } from "../model/ledLayout";
import { anchorForLed, ledOfAnchor } from "../model/startAnchor";
import {
  holdStart,
  keepStartAfterLayout,
  restoreStart,
  type StartPoint,
  type StripShape,
} from "../model/startPoint";
import { updateEditorConfig, type CalibrationEditorState } from "./calibrationEditorState";

/** How the page shows the counts; never saved, derived again from the counts on open. */
export type LayoutUi = Pick<LayoutDraft, "links" | "memo">;

export function layoutUiFrom(config: LedCalibrationConfig): LayoutUi {
  const { links, memo } = draftFromCounts(config.counts, config.bottomMissing);
  return { links, memo };
}

export function shapeOf(config: LedCalibrationConfig): StripShape {
  return { counts: config.counts, gap: config.bottomMissing };
}

export function draftOf(config: LedCalibrationConfig, ui: LayoutUi): LayoutDraft {
  return { counts: { ...config.counts }, gap: config.bottomMissing, ...ui };
}

export function startOf(config: LedCalibrationConfig): StartPoint {
  return { led: ledOfAnchor(config), direction: config.direction };
}

export type StartRule =
  /** Counts changed: an end or an edge's last LED stays that. */
  | { kind: "hold" }
  /** Edges switched on or off: an open strip restarts from an end. */
  | { kind: "layout" }
  | { kind: "set"; start: StartPoint };

export type LayoutPatch = Parameters<typeof updateEditorConfig>[1];

/** One edit of the layout, the start or both, as the patch that writes it back in the saved shape. */
export function layoutPatch(
  current: LedCalibrationConfig,
  ui: LayoutUi,
  draft: LayoutDraft,
  rule: StartRule,
): { patch: LayoutPatch; ui: LayoutUi } {
  const before = startOf(current);
  const shape: StripShape = { counts: draft.counts, gap: draft.gap };
  const start =
    rule.kind === "set"
      ? rule.start
      : rule.kind === "layout"
        ? keepStartAfterLayout(shape, before)
        : restoreStart(shape, before, holdStart(shapeOf(current), before));
  const anchor = anchorForLed(draft.counts, draft.gap, start.led);
  const nextUi = { links: draft.links, memo: draft.memo };
  return {
    patch: {
      counts: draft.counts,
      bottomMissing: draft.gap,
      startAnchor: anchor.startAnchor,
      startLocalIndex: anchor.startLocalIndex,
      direction: start.direction,
    },
    ui: sameUi(ui, nextUi) ? ui : nextUi,
  };
}

export function commitLayout(
  state: CalibrationEditorState,
  ui: LayoutUi,
  draft: LayoutDraft,
  rule: StartRule,
): { state: CalibrationEditorState; ui: LayoutUi } {
  const { patch, ui: nextUi } = layoutPatch(state.current, ui, draft, rule);
  return { state: updateEditorConfig(state, patch), ui: nextUi };
}

function sameUi(a: LayoutUi, b: LayoutUi): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
