import type {
  LedCalibrationConfig,
  LedDirection,
  LedSegmentCounts,
  LedStartAnchor,
} from "../model/contracts";
import { sumSegmentCounts } from "../model/contracts";

export interface CalibrationEditorState {
  baseline: LedCalibrationConfig;
  current: LedCalibrationConfig;
  isDirty: boolean;
  confirmDiscard: boolean;
  shouldClose: boolean;
}

interface EditorConfigPatch {
  templateId?: string;
  counts?: Partial<LedSegmentCounts>;
  bottomGapPx?: number;
  startAnchor?: LedStartAnchor;
  direction?: LedDirection;
}

function normalizeConfig(config: LedCalibrationConfig): LedCalibrationConfig {
  const counts = {
    top: config.counts.top,
    left: config.counts.left,
    right: config.counts.right,
    bottomLeft: config.counts.bottomLeft,
    bottomRight: config.counts.bottomRight,
  };

  return {
    templateId: config.templateId,
    counts,
    bottomGapPx: config.bottomGapPx,
    startAnchor: config.startAnchor,
    direction: config.direction,
    totalLeds: sumSegmentCounts(counts),
  };
}

function modelFingerprint(config: LedCalibrationConfig): string {
  const normalized = normalizeConfig(config);
  return JSON.stringify({
    templateId: normalized.templateId ?? null,
    counts: normalized.counts,
    bottomGapPx: normalized.bottomGapPx,
    startAnchor: normalized.startAnchor,
    direction: normalized.direction,
    totalLeds: normalized.totalLeds,
  });
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

export function createCalibrationEditorState(initial: LedCalibrationConfig): CalibrationEditorState {
  return buildState(initial, initial);
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
    bottomGapPx: patch.bottomGapPx ?? state.current.bottomGapPx,
    startAnchor: patch.startAnchor ?? state.current.startAnchor,
    direction: patch.direction ?? state.current.direction,
    totalLeds: state.current.totalLeds,
  };

  return buildState(state.baseline, next);
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
