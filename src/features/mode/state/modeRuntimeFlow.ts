import type { ShellState } from "../../../shared/contracts/shell";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  type LightingModeConfig,
  type LightingModeKind,
} from "../model/contracts";

export interface ModeTransitionResult {
  stopPrevious: boolean;
  startNext: Exclude<LightingModeKind, "off"> | null;
  steps: string[];
}

export function resolveModeTransition(
  _current: LightingModeConfig | undefined,
  next: LightingModeConfig,
): ModeTransitionResult {
  const normalizedNext = normalizeLightingModeConfig(next);

  if (normalizedNext.kind === LIGHTING_MODE_KIND.OFF) {
    return {
      stopPrevious: true,
      startNext: null,
      steps: ["stop"],
    };
  }

  return {
    stopPrevious: true,
    startNext: normalizedNext.kind,
    steps: ["stop", `start:${normalizedNext.kind}`],
  };
}

export function mergeLightingModeIntoShellState(
  state: ShellState,
  nextMode: LightingModeConfig,
): ShellState {
  const previousMode = state.lightingMode;
  const mergedMode: LightingModeConfig = {
    kind: nextMode.kind,
    solid: nextMode.solid ?? previousMode?.solid,
    ambilight: nextMode.ambilight ?? previousMode?.ambilight,
  };

  return {
    ...state,
    lightingMode: normalizeLightingModeConfig(mergedMode),
  };
}
