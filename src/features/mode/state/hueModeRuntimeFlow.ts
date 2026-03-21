import type { HueRuntimeTarget } from "../../../shared/contracts/hue";

const TARGET_ORDER: HueRuntimeTarget[] = ["usb", "hue"];

export type HueRuntimeAction = "start" | "stop";

export interface HueRuntimePlanInput {
  action: HueRuntimeAction;
  selectedTargets: HueRuntimeTarget[];
  activeTargets: HueRuntimeTarget[];
  stopTarget?: HueRuntimeTarget;
  userInitiated?: boolean;
  reconnectingTargets?: HueRuntimeTarget[];
}

export interface HueRuntimePlan {
  action: HueRuntimeAction;
  selectedTargets: HueRuntimeTarget[];
  activeBefore: HueRuntimeTarget[];
  startTargets: HueRuntimeTarget[];
  stopTargets: HueRuntimeTarget[];
  allowReconnect: boolean;
  steps: string[];
}

export interface HueTargetCommandResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface HueRuntimeTargetOutcome {
  outcome: "start_success" | "partial_start" | "start_failed" | "stop_success" | "stop_partial";
  activeTargets: HueRuntimeTarget[];
  stoppedTargets: HueRuntimeTarget[];
  failedTargets: HueRuntimeTarget[];
}

function normalizeTargets(targets: HueRuntimeTarget[]): HueRuntimeTarget[] {
  const targetSet = new Set(targets);
  return TARGET_ORDER.filter((target) => targetSet.has(target));
}

export function resolveHueRuntimePlan(input: HueRuntimePlanInput): HueRuntimePlan {
  const selectedTargets = normalizeTargets(input.selectedTargets);
  const activeBefore = normalizeTargets(input.activeTargets);
  const reconnectingTargets = normalizeTargets(input.reconnectingTargets ?? []);

  if (input.action === "start") {
    const startTargets = [...selectedTargets];

    return {
      action: "start",
      selectedTargets,
      activeBefore,
      startTargets,
      stopTargets: [],
      allowReconnect: true,
      steps: startTargets.map((target) => `start:${target}`),
    };
  }

  const stopTargets = input.stopTarget
    ? activeBefore.filter((target) => target === input.stopTarget)
    : [...activeBefore];
  const userInitiated = Boolean(input.userInitiated);
  const stopTargetSet = new Set(stopTargets);
  const cancelReconnectTargets = reconnectingTargets.filter((target) => stopTargetSet.has(target));

  return {
    action: "stop",
    selectedTargets,
    activeBefore,
    startTargets: [],
    stopTargets,
    allowReconnect: !userInitiated,
    steps: [
      ...cancelReconnectTargets.map((target) => `cancel-reconnect:${target}`),
      ...stopTargets.map((target) => `stop:${target}`),
    ],
  };
}

export function applyRuntimeResultToTargets(
  plan: HueRuntimePlan,
  resultByTarget: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>>,
): HueRuntimeTargetOutcome {
  if (plan.action === "start") {
    const successfulTargets = plan.startTargets.filter((target) => resultByTarget[target]?.ok === true);
    const failedTargets = plan.startTargets.filter((target) => resultByTarget[target]?.ok !== true);
    const activeTargets = normalizeTargets([...plan.activeBefore, ...successfulTargets]);

    if (failedTargets.length === 0) {
      return {
        outcome: "start_success",
        activeTargets,
        stoppedTargets: [],
        failedTargets: [],
      };
    }

    return {
      outcome: successfulTargets.length > 0 ? "partial_start" : "start_failed",
      activeTargets,
      stoppedTargets: [],
      failedTargets,
    };
  }

  const stoppedTargets = plan.stopTargets.filter((target) => resultByTarget[target]?.ok === true);
  const failedTargets = plan.stopTargets.filter((target) => resultByTarget[target]?.ok !== true);
  const stoppedSet = new Set(stoppedTargets);
  const activeTargets = normalizeTargets(plan.activeBefore.filter((target) => !stoppedSet.has(target)));

  return {
    outcome: failedTargets.length > 0 ? "stop_partial" : "stop_success",
    activeTargets,
    stoppedTargets,
    failedTargets,
  };
}
