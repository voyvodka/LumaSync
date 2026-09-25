import type {
  CornerOwnership,
  LedCalibrationConfig,
  LedDirection,
  LedSegmentCounts,
  LedStartAnchor,
  LedVisualPreset,
} from "../model/contracts";
import {
  normalizeLedCalibrationConfig,
  normalizeStartAnchor,
  sumSegmentCounts,
} from "../model/contracts";

export interface CalibrationEditorState {
  baseline: LedCalibrationConfig;
  current: LedCalibrationConfig;
  isDirty: boolean;
  confirmDiscard: boolean;
  shouldClose: boolean;
}

interface EditorConfigPatch {
  templateId?: string | null;
  counts?: Partial<LedSegmentCounts>;
  bottomMissing?: number;
  cornerOwnership?: CornerOwnership;
  visualPreset?: LedVisualPreset;
  startAnchor?: LedStartAnchor;
  direction?: LedDirection;
}

type CalibrationDraftModel = Omit<LedCalibrationConfig, "totalLeds">;

function normalizeConfig(config: LedCalibrationConfig): LedCalibrationConfig {
  const normalized = normalizeLedCalibrationConfig(config);
  if (normalized) {
    return normalized;
  }

  const counts = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  return {
    templateId: undefined,
    counts,
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: normalizeStartAnchor(config.startAnchor),
    direction: config.direction === "ccw" ? "ccw" : "cw",
    totalLeds: sumSegmentCounts(counts),
  };
}

function normalizeDraft(config: CalibrationDraftModel): LedCalibrationConfig {
  return normalizeConfig(config as LedCalibrationConfig);
}

function modelFingerprint(config: LedCalibrationConfig): string {
  const normalized = normalizeConfig(config);
  return JSON.stringify({
    templateId: normalized.templateId ?? null,
    counts: normalized.counts,
    bottomMissing: normalized.bottomMissing,
    cornerOwnership: normalized.cornerOwnership,
    visualPreset: normalized.visualPreset,
    startAnchor: normalized.startAnchor,
    direction: normalized.direction,
    totalLeds: normalized.totalLeds,
  });
}

/** A layout's identity, ignoring anything normalisation would heal. */
export function calibrationLayoutKey(config: LedCalibrationConfig): string {
  return modelFingerprint(config);
}

export function isSameCalibrationLayout(a: LedCalibrationConfig, b: LedCalibrationConfig): boolean {
  return modelFingerprint(a) === modelFingerprint(b);
}

function buildState(
  baseline: LedCalibrationConfig,
  current: LedCalibrationConfig,
  extra?: Partial<Pick<CalibrationEditorState, "confirmDiscard" | "shouldClose">>,
): CalibrationEditorState {
  const normalizedBaseline = normalizeConfig(baseline);
  const normalizedCurrent = normalizeConfig(current);

  return {
    baseline: normalizedBaseline,
    current: normalizedCurrent,
    isDirty: modelFingerprint(normalizedBaseline) !== modelFingerprint(normalizedCurrent),
    confirmDiscard: extra?.confirmDiscard ?? false,
    shouldClose: extra?.shouldClose ?? false,
  };
}

export function createCalibrationEditorState(
  initial: LedCalibrationConfig,
  draftCounts?: LedSegmentCounts | null,
): CalibrationEditorState {
  const clean = buildState(initial, initial);
  // Counts handed over from elsewhere (the room map) are a proposal, not the
  // saved layout: they start as the draft so Cancel and leaving both ask.
  return draftCounts ? updateEditorConfig(clean, { counts: draftCounts }) : clean;
}

export function updateEditorConfig(
  state: CalibrationEditorState,
  patch: EditorConfigPatch,
): CalibrationEditorState {
  const next: LedCalibrationConfig = {
    ...state.current,
    templateId: patch.templateId ?? state.current.templateId,
    counts: {
      ...state.current.counts,
      ...patch.counts,
    },
    bottomMissing: patch.bottomMissing ?? state.current.bottomMissing,
    cornerOwnership: patch.cornerOwnership ?? state.current.cornerOwnership,
    visualPreset: patch.visualPreset ?? state.current.visualPreset,
    startAnchor: patch.startAnchor ?? state.current.startAnchor,
    direction: patch.direction ?? state.current.direction,
    totalLeds: state.current.totalLeds,
  };

  return buildState(state.baseline, next);
}

/**
 * An automatic fill (display-derived defaults) rather than a user edit: while
 * nothing has been touched it moves the baseline too, so the first visit is not
 * "unsaved" before the user has done anything. Once the draft is dirty it lands
 * on the draft alone, like any edit.
 */
export function autofillEditorConfig(
  state: CalibrationEditorState,
  patch: EditorConfigPatch,
): CalibrationEditorState {
  const next = updateEditorConfig(state, patch);
  if (state.isDirty) return next;
  return buildState(next.current, next.current);
}

export function loadEditorConfig(
  state: CalibrationEditorState,
  model: CalibrationDraftModel,
): CalibrationEditorState {
  return buildState(state.baseline, normalizeDraft(model));
}

export function saveEditorCalibration(state: CalibrationEditorState): CalibrationEditorState {
  return buildState(state.current, state.current);
}

export function requestEditorClose(state: CalibrationEditorState): CalibrationEditorState {
  if (state.isDirty) {
    return {
      ...state,
      confirmDiscard: true,
      shouldClose: false,
    };
  }

  return {
    ...state,
    confirmDiscard: false,
    shouldClose: true,
  };
}

export function keepEditing(state: CalibrationEditorState): CalibrationEditorState {
  return {
    ...state,
    confirmDiscard: false,
    shouldClose: false,
  };
}

export function discardEditorChanges(state: CalibrationEditorState): CalibrationEditorState {
  return {
    ...buildState(state.baseline, state.baseline),
    shouldClose: true,
    confirmDiscard: false,
  };
}
