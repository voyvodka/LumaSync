import type { TFunction } from "i18next";

import type { MenuConfirm } from "@/shared/ui/Menu/Menu";
import type { TranslationKey } from "@/features/i18n/catalogue";
import { hueStreamFailureReasonKey, type HueBridgeCardState } from "@/features/hue/model/hueBridgeCardState";
import type { HueRuntimeStatusCardModel } from "@/features/hue/model/hueRuntimeStatusCard";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";

import type { HueAreaChoice } from "./useHueAreaChoice";

/** Everything a state reads to draw itself. Built once per render. */
export interface HueContext {
  t: TFunction;
  hue: UseHueOnboardingResult;
  runtimeModel: HueRuntimeStatusCardModel;
  pairingErrorKey: TranslationKey | null;
  /** Computed once so every action that shares a gate reads the same answer. */
  gates: {
    areasDisabled: boolean;
    readinessDisabled: boolean;
    startDisabled: boolean;
  };
  /** Not `stopHue`: a running mode that names Hue has to let go of it first. */
  onStopHue: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
  areaChoice: HueAreaChoice;
  /** Forgets the bridge; `forgetConfirm` is the question asked first, when there is a pairing to lose. */
  forget: () => void;
  forgetConfirm: MenuConfirm | undefined;
  isForgetting: boolean;
}

export interface HueActionSpec {
  label: string;
  /** Shown while it runs; the button keeps the width of the longer of the two. */
  busyLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Lets something go: behind "…" it warms to red on hover or focus. */
  danger?: boolean;
  /** Behind "…", asked beside it before `onClick` runs. */
  confirm?: MenuConfirm;
}

/** The state dot beside the word: live (green, filled), ready (green ring), busy (a turning
 *  ring), warn (amber), error (red), idle (grey ring). */
export type HueTone = "live" | "ready" | "busy" | "warn" | "error" | "idle";

/** The line under the bridge row: what happened and what to do, with the raw code behind ⓘ. */
export interface HueNote {
  lines: readonly string[];
  code?: string | null;
  testId?: string;
}

/**
 * One row per bridge state. Every field is required — `null` or `[]` where a state has nothing —
 * so a new state cannot compile until it has decided all of them.
 */
export interface HueStateView {
  /** The bridge row's state, one or two words. */
  word: TranslationKey;
  tone: HueTone;
  note: ((ctx: HueContext) => HueNote | null) | null;
  /** The page's one amber action. `changeArea` puts it on the area row. */
  primary: HueActionId | null;
  /** Grey, beside the primary. */
  secondary: readonly HueActionId[];
  /** Behind the bridge row's "…". */
  more: readonly HueActionId[];
  /** The area row: its value and a way to change it, its value only, or no row. */
  area: "change" | "show" | null;
}

// ── Actions ─────────────────────────────────────────────────────────────

const retryTarget = ({ hue }: HueContext) => hue.runtimeTargets[0]?.target ?? "hue";
const stopFromPage = ({ onStopHue }: HueContext) => {
  void onStopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
};

// Forget asks first and then clears everything the app keeps about the bridge.
const forgetAction =
  (label: TranslationKey) =>
  ({ t, forget, forgetConfirm, isForgetting }: HueContext): HueActionSpec => ({
    label: t(label),
    busyLabel: t("hue:page.forgetting"),
    onClick: forget,
    confirm: forgetConfirm,
    busy: isForgetting,
    danger: true,
  });

const repairAction = ({ t, hue }: HueContext): HueActionSpec => ({
  label: t("hue:runtime.actions.repair"),
  busyLabel: t("hue:actions.pairing"),
  onClick: () => {
    void hue.pair();
  },
  busy: hue.isPairing,
});

export const HUE_ACTIONS = {
  changeArea: ({ t, hue, gates, areaChoice }) => ({
    label: hue.selectedAreaId === null ? t("hue:page.chooseArea") : t("hue:page.changeArea"),
    onClick: areaChoice.toggle,
    disabled: gates.areasDisabled,
  }),
  refreshAreas: ({ t, hue, gates }) => ({
    label: t("hue:actions.refreshAreas"),
    busyLabel: t("hue:busy.refreshing"),
    onClick: () => {
      void hue.refreshAreas();
    },
    disabled: gates.areasDisabled,
    busy: hue.isLoadingAreas,
  }),
  validate: ({ t, hue, gates }) => ({
    label: t("hue:page.validate"),
    busyLabel: t("hue:busy.checking"),
    onClick: () => {
      void hue.revalidateArea();
    },
    disabled: gates.readinessDisabled,
    busy: hue.isCheckingReadiness,
  }),
  restartStream: ({ t, hue, gates }) => ({
    label: t("hue:page.reconnectNow"),
    onClick: () => {
      void hue.startRuntime();
    },
    disabled: gates.startDisabled,
    busy: hue.isRuntimeMutating,
  }),
  reconnectNow: (ctx) => ({
    label: ctx.t("hue:page.reconnectNow"),
    onClick: () => {
      void ctx.hue.retryRuntimeTarget(retryTarget(ctx));
    },
    busy: ctx.hue.isRuntimeMutating,
  }),
  // Restart, not start: it re-reads readiness itself, so a stale check cannot block the way back.
  startAgain: (ctx) => ({
    label: ctx.t("hue:page.startAgain"),
    onClick: () => {
      void ctx.hue.retryRuntimeTarget(retryTarget(ctx));
    },
    busy: ctx.hue.isRuntimeMutating,
  }),
  stopRetrying: (ctx) => ({
    label: ctx.t("hue:page.stopRetrying"),
    onClick: () => {
      stopFromPage(ctx);
    },
    busy: ctx.hue.isRuntimeMutating,
  }),
  // The shell's stop-failed notice runs the same stop under the same label.
  stopHue: (ctx) => ({
    label: ctx.t("hue:actions.stop"),
    onClick: () => {
      stopFromPage(ctx);
    },
    busy: ctx.hue.isRuntimeMutating,
  }),
  pairBridge: ({ t, hue }) => ({
    label: t("hue:page.pair"),
    onClick: () => {
      void hue.pair();
    },
  }),
  retryBridge: ({ t, hue }) => ({
    label: t("hue:page.retry"),
    busyLabel: t("hue:busy.trying"),
    onClick: () => {
      void hue.recheckBridge();
    },
    busy: hue.isValidatingCredential,
  }),
  tryPairAgain: ({ t, hue }) => ({
    label: t("hue:pair.tryAgain"),
    onClick: () => {
      void hue.pair();
    },
  }),
  repair: repairAction,
  // Re-pair is offered only when the runtime itself says the key was refused.
  repairIfKeyRefused: (ctx) =>
    ctx.runtimeModel.actionHints.includes(HUE_RUNTIME_ACTION_HINT.REPAIR) ? repairAction(ctx) : null,
  rediscover: ({ t, hue }) => ({
    label: t("hue:wizard.offlineRediscover"),
    busyLabel: t("hue:busy.searching"),
    onClick: () => {
      void hue.discover();
    },
    busy: hue.isDiscovering,
  }),
  forget: forgetAction("hue:page.forgotBridge"),
  forceForget: forgetAction("hue:page.forceForget"),
  // Walking away from a pairing run or an unpaired selection: nothing is saved for it yet, so
  // letting go of the selection is all there is to undo.
  cancel: ({ t, hue }) => ({
    label: t("hue:page.cancel"),
    onClick: () => {
      hue.selectBridge(null);
    },
  }),
} satisfies Record<string, (ctx: HueContext) => HueActionSpec | null>;

export type HueActionId = keyof typeof HUE_ACTIONS;

// ── Codes ───────────────────────────────────────────────────────────────

const SUCCESS_CODE = /_(OK|VALID|READY|IDLE|APPLIED|UPDATED)$|^HUE_STREAM_(RUNNING|STARTING|STOPPING|STOPPED)|NOOP/;

/** A code fit to caption a failure: the last onboarding answer is often a success
 *  (`HUE_DISCOVERY_OK`) that has nothing to do with the state on show. */
export function failureCaptionCode(code: string | null | undefined): string | null {
  return code && !SUCCESS_CODE.test(code) ? code : null;
}

const isAuthFailureCode = (code: string | null | undefined): code is string =>
  Boolean(code && (code.startsWith("AUTH_INVALID") || code === "HUE_CREDENTIAL_INVALID"));

/** Why the key reads as refused: the runtime's code when it was the one to hear it, else the
 *  onboarding answer that said so. */
export function authErrorCaptionCode(hue: UseHueOnboardingResult): string | null {
  const runtimeCode = hue.runtimeStatus?.code;
  if (isAuthFailureCode(runtimeCode)) return runtimeCode;
  const onboardingCode = hue.status?.code;
  return isAuthFailureCode(onboardingCode) ? onboardingCode : null;
}

const note =
  (key: TranslationKey, testId?: string, code?: (ctx: HueContext) => string | null | undefined) =>
  (ctx: HueContext): HueNote => ({ lines: [ctx.t(key)], code: code?.(ctx), testId });

const pairingErrorNote =
  (testId: string) =>
  ({ t, pairingErrorKey }: HueContext): HueNote | null =>
    pairingErrorKey ? { lines: [t(pairingErrorKey)], testId } : null;

// ── The table ───────────────────────────────────────────────────────────

export const HUE_STATE_VIEW = {
  streaming: {
    word: "hue:state.streaming",
    tone: "live",
    note: null,
    primary: null,
    secondary: [],
    more: ["stopHue", "restartStream", "forget"],
    area: "change",
  },
  idle: {
    word: "hue:state.idle",
    tone: "ready",
    note: null,
    primary: null,
    secondary: [],
    more: ["validate", "forget"],
    area: "change",
  },
  statusUnknown: {
    word: "hue:state.statusUnknown",
    tone: "warn",
    note: note("hue:runtime.statusUnavailable.body", "hue-status-unavailable", ({ hue }) => hue.runtimeStatusReadFailure?.code),
    primary: null,
    secondary: ["validate"],
    more: ["forget"],
    area: "change",
  },
  stale: {
    word: "hue:state.stale",
    tone: "warn",
    note: note("hue:runtime.checklist.revalidate", "hue-stale"),
    primary: "validate",
    secondary: [],
    more: ["forget"],
    area: "show",
  },
  reconnecting: {
    word: "hue:state.reconnecting",
    tone: "busy",
    note: ({ t, hue, runtimeModel }) => ({
      lines: [
        runtimeModel.retry
          ? t(runtimeModel.retry.labelKey, {
              remaining: runtimeModel.retry.remainingAttempts ?? "—",
              nextMs: runtimeModel.retry.nextAttemptMs ?? "—",
            })
          : t("hue:runtime.reconnectingTitle"),
      ],
      code: failureCaptionCode(hue.runtimeStatus?.code),
    }),
    primary: null,
    secondary: ["reconnectNow", "stopRetrying"],
    more: ["forget"],
    area: "show",
  },
  streamFailed: {
    word: "hue:state.streamFailed",
    tone: "error",
    note: ({ t, hue }) => ({
      lines: [t(hueStreamFailureReasonKey(hue.runtimeStatus?.code))],
      code: hue.runtimeStatus?.code ?? null,
      testId: "hue-stream-failed",
    }),
    primary: "startAgain",
    secondary: ["repairIfKeyRefused"],
    more: ["forget"],
    area: "show",
  },
  stopPartial: {
    word: "hue:state.stopPartial",
    tone: "error",
    note: note("hue:runtime.partialStop.body", undefined, ({ hue }) => hue.runtimeStatus?.code),
    primary: "stopHue",
    secondary: [],
    more: ["forceForget"],
    area: "show",
  },
  // Always one line of why: the list used to render empty unless the readiness had also gone stale.
  gateBlocked: {
    word: "hue:state.gateBlocked",
    tone: "warn",
    note: ({ t, hue }) => ({
      lines: [
        hue.runtimeStatus?.details?.includes("HUE_STREAM_READINESS_FAILED")
          ? t("hue:runtime.checklist.bridgeSilent")
          : t("hue:runtime.checklist.notConfirmed"),
        ...(hue.isReadinessStale ? [t("hue:runtime.checklist.revalidate")] : []),
      ],
      code: hue.runtimeStatus?.code,
      testId: "hue-gate-blocked",
    }),
    primary: "validate",
    secondary: [],
    more: ["forget"],
    area: "change",
  },
  authError: {
    word: "hue:state.authError",
    tone: "error",
    note: note("hue:credential.repairHint", "hue-auth-error", ({ hue }) => authErrorCaptionCode(hue)),
    primary: "repair",
    secondary: [],
    more: ["forget"],
    area: null,
  },
  pairingFailed: {
    word: "hue:state.pairingFailed",
    tone: "error",
    note: pairingErrorNote("hue-pairing-failed-reason"),
    primary: "repair",
    secondary: [],
    more: ["forget"],
    area: null,
  },
  offline: {
    word: "hue:bridge.unreachable",
    tone: "error",
    note: note("hue:state.offlineNote"),
    primary: "retryBridge",
    // The address row below is the other way back; a search of the network is the rarer one.
    secondary: [],
    more: ["rediscover", "forget"],
    area: null,
  },
  pairing: {
    word: "hue:state.pairing",
    tone: "busy",
    note: null,
    primary: null,
    secondary: ["cancel"],
    more: [],
    area: null,
  },
  pairingLinkButton: {
    word: "hue:state.pairingLinkButton",
    tone: "busy",
    note: note("hue:pair.linkButtonHint"),
    primary: null,
    secondary: ["cancel"],
    more: [],
    area: null,
  },
  pairingTimedOut: {
    word: "hue:state.pairingTimedOut",
    tone: "warn",
    note: note("hue:pair.timedOutHint"),
    primary: "tryPairAgain",
    secondary: ["cancel"],
    more: [],
    area: null,
  },
  pairingDeferred: {
    word: "hue:state.pairingDeferred",
    tone: "warn",
    note: pairingErrorNote("hue-pairing-deferred"),
    primary: "tryPairAgain",
    secondary: ["cancel"],
    more: [],
    area: null,
  },
  areaSelect: {
    word: "hue:state.areaSelect",
    tone: "ready",
    note: null,
    primary: "changeArea",
    secondary: [],
    more: ["forget"],
    area: "change",
  },
  areaBusy: {
    word: "hue:state.areaBusy",
    tone: "warn",
    note: note("hue:card.areaBusy.body", "hue-area-busy"),
    primary: "changeArea",
    secondary: [],
    more: ["forget"],
    area: "change",
  },
  unpaired: {
    word: "hue:state.unpaired",
    tone: "idle",
    note: note("hue:pair.promptHint", "hue-pair-prompt"),
    primary: "pairBridge",
    secondary: ["cancel"],
    more: [],
    area: null,
  },
  checkingCredentials: {
    word: "hue:state.checkingCredentials",
    tone: "busy",
    note: null,
    primary: null,
    secondary: [],
    more: ["forget"],
    area: "show",
  },
} satisfies Record<HueBridgeCardState, HueStateView>;

/** The actions a list of ids resolves to, minus the ones that do not apply right now. */
export function resolveActions(ids: readonly HueActionId[], ctx: HueContext) {
  return ids.flatMap((id) => {
    const spec: HueActionSpec | null = HUE_ACTIONS[id](ctx);
    return spec ? [{ id, ...spec }] : [];
  });
}
