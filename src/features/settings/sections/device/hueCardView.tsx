import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { hueStreamFailureReasonKey, type HueBridgeCardState } from "@/features/hue/model/hueBridgeCardState";
import type { HueRuntimeStatusCardModel } from "@/features/hue/model/hueRuntimeStatusCard";
import { HUE_STREAM_MAX_HZ } from "@/features/hue/model/streamRate";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";
import { cx } from "@/shared/ui/cx";
import { IconCheck, IconInfo } from "@/shared/ui/icons";
import type { StatusPillTone } from "@/shared/ui/StatusPill";

import { HueAreaPicker } from "./HueAreaPicker";
import type { HueAreaChoice } from "./useHueAreaChoice";

/** Everything a card state reads to draw itself. Built once per render. */
export interface HueCardContext {
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
}

type HueCardText = TranslationKey | ((ctx: HueCardContext) => string);

export type HueCardTone = "on" | "offline" | "error" | "warn" | "ghost";

export const HUE_CARD_TONE_CLASS = {
  on: "is-on",
  offline: "is-offline",
  error: "is-error-state",
  warn: "is-warn-state",
  ghost: "is-ghost",
} as const satisfies Record<HueCardTone, string>;

type HueCardCellTone = "am" | "dim" | "ok" | "warn" | "error";

export const HUE_CARD_CELL_TONE_CLASS = {
  am: "is-am",
  dim: "is-dim",
  ok: "is-ok",
  warn: "is-warn",
  error: "is-error",
} as const satisfies Record<HueCardCellTone, string>;

export interface HueCardCell {
  label: TranslationKey;
  value: ReactNode;
  tone?: HueCardCellTone;
}

export interface HueCardActionSpec {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  primary?: boolean;
}

/**
 * One row per card state. Every field is required — `null` or `[]` where a
 * state has nothing to show — so a new state cannot compile until it has
 * decided all of them.
 */
export interface HueCardView {
  /** The page header's one-line status. */
  subtitle: HueCardText;
  tone: HueCardTone | null;
  pill: { tone: StatusPillTone; label: TranslationKey };
  /** Between the card header and the stat cells. */
  lead: ((ctx: HueCardContext) => ReactNode) | null;
  cells: (ctx: HueCardContext) => readonly HueCardCell[];
  /** Below the stat cells. */
  detail: ((ctx: HueCardContext) => ReactNode) | null;
  /** The footer, in order. A card's actions live only here. */
  actions: readonly HueCardActionId[];
}

export function resolveHueCardText(text: HueCardText, ctx: HueCardContext): string {
  return typeof text === "function" ? text(ctx) : ctx.t(text);
}

// ── Actions ─────────────────────────────────────────────────────────────

const retryTarget = ({ hue }: HueCardContext) => hue.runtimeTargets[0]?.target ?? "hue";
const stopFromCard = ({ onStopHue }: HueCardContext) => {
  void onStopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
};

const forgetAction = (label: TranslationKey) => ({ t, hue }: HueCardContext): HueCardActionSpec => ({
  label: t(label),
  onClick: () => { hue.selectBridge(null); },
  danger: true,
});

const repairAction = ({ t, hue }: HueCardContext): HueCardActionSpec => ({
  label: hue.isPairing ? t("hue:actions.pairing") : t("hue:runtime.actions.repair"),
  onClick: () => { void hue.pair(); },
  busy: hue.isPairing,
});

export const HUE_CARD_ACTIONS = {
  changeArea: ({ t, hue, gates, areaChoice }) => ({
    label: t("hue:page.changeArea"),
    onClick: areaChoice.start,
    disabled: gates.areasDisabled,
    busy: hue.isLoadingAreas,
  }),
  confirmArea: ({ t, hue, gates, areaChoice }) => ({
    label: hue.isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.confirmArea"),
    onClick: areaChoice.confirm,
    disabled: areaChoice.draftId === null || gates.areasDisabled,
    busy: hue.isCheckingReadiness,
    primary: true,
  }),
  cancelAreaChange: ({ t, areaChoice }) => ({
    label: t("hue:page.cancel"),
    onClick: areaChoice.cancel,
  }),
  refreshAreas: ({ t, hue, gates }) => ({
    label: hue.isLoadingAreas ? t("hue:actions.loadingAreas") : t("hue:actions.refreshAreas"),
    onClick: () => { void hue.refreshAreas(); },
    disabled: gates.areasDisabled,
    busy: hue.isLoadingAreas,
  }),
  validate: ({ t, hue, gates }) => ({
    label: hue.isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.validate"),
    onClick: () => { void hue.revalidateArea(); },
    disabled: gates.readinessDisabled,
    busy: hue.isCheckingReadiness,
  }),
  start: ({ t, hue, gates }) => ({
    label: t("hue:actions.start"),
    onClick: () => { void hue.startRuntime(); },
    disabled: gates.startDisabled,
  }),
  restartStream: ({ t, hue, gates }) => ({
    label: t("hue:page.reconnectNow"),
    onClick: () => { void hue.startRuntime(); },
    disabled: gates.startDisabled,
    busy: hue.isRuntimeMutating,
  }),
  reconnectNow: (ctx) => ({
    label: ctx.t("hue:page.reconnectNow"),
    onClick: () => { void ctx.hue.retryRuntimeTarget(retryTarget(ctx)); },
    busy: ctx.hue.isRuntimeMutating,
  }),
  // Restart, not start: it re-reads readiness itself, so a stale check on
  // this card cannot block the way back.
  startAgain: (ctx) => ({
    label: ctx.t("hue:page.startAgain"),
    onClick: () => { void ctx.hue.retryRuntimeTarget(retryTarget(ctx)); },
    busy: ctx.hue.isRuntimeMutating,
  }),
  stopRetrying: (ctx) => ({
    label: ctx.t("hue:page.stopRetrying"),
    onClick: () => { stopFromCard(ctx); },
    busy: ctx.hue.isRuntimeMutating,
    danger: true,
  }),
  // The shell's stop-failed notice runs the same stop under the same label.
  stopHue: (ctx) => ({
    label: ctx.t("hue:actions.stop"),
    onClick: () => { stopFromCard(ctx); },
    busy: ctx.hue.isRuntimeMutating,
  }),
  tryPairAgain: ({ t, hue }) => ({
    label: t("hue:pair.tryAgain"),
    onClick: () => { void hue.pair(); },
  }),
  repair: repairAction,
  // Re-pair is offered only when the runtime itself says the key was refused.
  repairIfKeyRefused: (ctx) =>
    ctx.runtimeModel.actionHints.includes(HUE_RUNTIME_ACTION_HINT.REPAIR) ? repairAction(ctx) : null,
  rediscover: ({ t, hue }) => ({
    label: hue.isDiscovering ? t("hue:actions.discovering") : t("hue:wizard.offlineRediscover"),
    onClick: () => { void hue.discover(); },
    busy: hue.isDiscovering,
  }),
  differentIp: ({ t, hue }) => ({
    label: t("hue:page.tryDifferentIp"),
    onClick: () => { hue.setManualIp(""); },
  }),
  forget: forgetAction("hue:page.forgotBridge"),
  cancel: forgetAction("hue:page.cancel"),
  forceForget: forgetAction("hue:page.forceForget"),
} satisfies Record<string, (ctx: HueCardContext) => HueCardActionSpec | null>;

export type HueCardActionId = keyof typeof HUE_CARD_ACTIONS;

// ── Stat cells ──────────────────────────────────────────────────────────

const areaName = ({ hue }: HueCardContext) => hue.selectedArea?.name ?? "—";

const areaCell = (ctx: HueCardContext, tone?: HueCardCellTone): HueCardCell => ({
  label: "hue:card.cellArea",
  value: areaName(ctx),
  tone,
});

/** For states that only name the area when one is actually selected. */
const selectedAreaCells = ({ hue }: HueCardContext): HueCardCell[] =>
  hue.selectedArea ? [{ label: "hue:card.cellArea", value: hue.selectedArea.name, tone: "dim" }] : [];

const PROTOCOL_CELL: HueCardCell = { label: "hue:card.cellProtocol", value: "DTLS", tone: "dim" };

const channelCells = ({ hue }: HueCardContext): HueCardCell[] =>
  hue.selectedArea?.channelCount !== undefined
    ? [{ label: "hue:card.cellCh", value: hue.selectedArea.channelCount }]
    : [];

const statusCell = (ctx: HueCardContext, label: TranslationKey, tone: HueCardCellTone): HueCardCell => ({
  label: "hue:card.cellStatus",
  value: ctx.t(label),
  tone,
});

const NO_CELLS = (): HueCardCell[] => [];

// ── Body pieces ─────────────────────────────────────────────────────────

interface HueRepairNoteProps {
  title: string;
  sub: string;
  error?: boolean;
  code?: string | null;
  testId?: string;
}

/** The card's inline fault box: what happened, what to do, and the code as a caption. */
function HueRepairNote({ title, sub, error = false, code, testId }: HueRepairNoteProps) {
  return (
    <div className={cx("lm-hue-repair", error && "is-error")} role="status" aria-live="polite" data-testid={testId}>
      <IconInfo />
      <div className="lm-hue-repair-tx">
        <div className="lm-hue-repair-title">{title}</div>
        <div className="lm-hue-repair-sub">{sub}</div>
        {code !== undefined ? <StatusCodeDetail code={code} /> : null}
      </div>
    </div>
  );
}

const PAIRING_STEPS: readonly TranslationKey[] = [
  "hue:steps.discover",
  "hue:steps.pair",
  "hue:steps.area",
  "hue:steps.ready",
];

/** Discover is done; pairing is the current step, or the one that failed. */
function HuePairingSteps({ t, failed }: { t: TFunction; failed: boolean }) {
  return (
    <div className="lm-hue-steps">
      {PAIRING_STEPS.map((label, index) => {
        const stepClass = index === 0 ? "is-done" : index === 1 ? (failed ? "is-fail" : "is-active") : undefined;
        return (
          <HuePairingStep key={label} index={index} stepClass={stepClass}>
            {t(label)}
          </HuePairingStep>
        );
      })}
    </div>
  );
}

interface HuePairingStepProps {
  index: number;
  stepClass?: string;
  children: ReactNode;
}

/** A step and the line leading into it; the first step has no line. */
function HuePairingStep({ index, stepClass, children }: HuePairingStepProps) {
  return (
    <>
      {index > 0 ? <div className={cx("lm-hue-step-line", index === 1 && "is-done")} /> : null}
      <div className={cx("lm-hue-step", stepClass)}>
        <span className="lm-hue-step-dot">{index === 0 ? <IconCheck /> : null}</span>
        <span>{children}</span>
      </div>
    </>
  );
}

interface StatusCodeDetailProps {
  code: string | null | undefined;
}

/** The raw status code as a small caption under the message: readable for
 *  support, never the card's headline. */
export function StatusCodeDetail({ code }: StatusCodeDetailProps) {
  const { t } = useTranslation();
  if (!code) return null;
  return (
    <span className="lm-hue-code" data-testid="hue-fault-code">
      <span className="lm-hue-code-k">{t("hue:card.codeLabel")}</span> <code>{code}</code>
    </span>
  );
}

// ── The table ───────────────────────────────────────────────────────────

export const HUE_CARD_VIEW = {
  streaming: {
    subtitle: (ctx) => ctx.t("hue:card.subtitleStreaming", { area: areaName(ctx) }),
    tone: "on",
    pill: { tone: "streaming", label: "hue:page.pill.streaming" },
    lead: ({ t }) => (
      <div className="lm-hue-traffic">
        <div className="lm-hue-traffic-bar">
          <div className="lm-hue-traffic-fill" />
        </div>
        <div className="lm-hue-traffic-label">
          <span>{t("hue:card.trafficLabel")}</span>
          <b>DTLS · {t("hue:card.rateHz", { hz: HUE_STREAM_MAX_HZ })}</b>
        </div>
      </div>
    ),
    cells: (ctx) => [
      areaCell(ctx, "am"),
      PROTOCOL_CELL,
      ...channelCells(ctx),
      { label: "hue:card.cellRate", value: ctx.t("hue:card.rateHz", { hz: HUE_STREAM_MAX_HZ }), tone: "am" },
    ],
    detail: null,
    actions: ["changeArea", "restartStream", "forget"],
  },
  idle: {
    subtitle: (ctx) => `${areaName(ctx)} · ${ctx.t("hue:page.pill.ready").toLowerCase()}`,
    tone: null,
    pill: { tone: "idle", label: "hue:page.pill.ready" },
    lead: null,
    cells: (ctx) => [areaCell(ctx), PROTOCOL_CELL, ...channelCells(ctx), statusCell(ctx, "hue:page.pill.ready", "ok")],
    detail: null,
    actions: ["changeArea", "validate", "forget"],
  },
  statusUnknown: {
    subtitle: "hue:runtime.statusUnavailable.title",
    tone: "warn",
    pill: { tone: "warn", label: "hue:page.pill.checking" },
    lead: null,
    cells: (ctx) => [areaCell(ctx, "dim"), statusCell(ctx, "hue:page.pill.checking", "warn")],
    detail: ({ t, hue }) => (
      <div className="lm-hue-retry" role="status" aria-live="polite" data-testid="hue-status-unavailable">
        <span className="lm-hue-retry-sp" aria-hidden="true" />
        <span className="lm-hue-retry-tx">
          {t("hue:runtime.statusUnavailable.body")}
          <StatusCodeDetail code={hue.runtimeStatusReadFailure?.code} />
        </span>
      </div>
    ),
    actions: ["changeArea", "validate", "forget"],
  },
  stale: {
    subtitle: "hue:runtime.checklist.revalidate",
    tone: "warn",
    pill: { tone: "warn", label: "hue:page.pill.awaiting" },
    lead: null,
    cells: (ctx) => [areaCell(ctx), PROTOCOL_CELL, ...channelCells(ctx), statusCell(ctx, "hue:page.pill.awaiting", "warn")],
    // Validate lives in the footer.
    detail: ({ t }) => (
      <div className="lm-hue-stale" data-testid="hue-stale">
        <IconInfo />
        <span className="lm-hue-stale-tx">{t("hue:runtime.checklist.revalidate")}</span>
      </div>
    ),
    actions: ["validate", "start", "forget"],
  },
  reconnecting: {
    subtitle: "hue:runtime.reconnectingTitle",
    tone: "warn",
    pill: { tone: "warn", label: "hue:page.pill.reconnecting" },
    lead: null,
    cells: (ctx) => {
      const retry = ctx.runtimeModel.retry;
      const cells: HueCardCell[] = [areaCell(ctx, "dim")];
      if (retry?.remainingAttempts !== undefined) {
        cells.push({ label: "hue:card.cellRetries", value: retry.remainingAttempts, tone: "am" });
      }
      if (retry?.nextAttemptMs !== undefined) {
        cells.push({ label: "hue:card.cellNext", value: `${(retry.nextAttemptMs / 1000).toFixed(1)} s`, tone: "am" });
      }
      return cells;
    },
    detail: ({ t, hue, runtimeModel }) => (
      <div className="lm-hue-retry">
        <span className="lm-hue-retry-sp" aria-hidden="true" />
        <span className="lm-hue-retry-tx">
          {runtimeModel.retry
            ? t(runtimeModel.retry.labelKey, {
                remaining: runtimeModel.retry.remainingAttempts ?? "—",
                nextMs: runtimeModel.retry.nextAttemptMs ?? "—",
              })
            : t("hue:runtime.reconnectingTitle")}
          <StatusCodeDetail code={hue.status?.code} />
        </span>
      </div>
    ),
    actions: ["reconnectNow", "stopRetrying"],
  },
  streamFailed: {
    subtitle: "hue:runtime.failed.title",
    tone: "error",
    pill: { tone: "error", label: "hue:page.pill.failed" },
    lead: null,
    cells: (ctx) => [areaCell(ctx, "dim")],
    detail: ({ t, hue }) => (
      <HueRepairNote
        error
        title={t("hue:runtime.failed.title")}
        sub={t(hueStreamFailureReasonKey(hue.runtimeStatus?.code))}
        code={hue.runtimeStatus?.code ?? null}
        testId="hue-stream-failed"
      />
    ),
    actions: ["repairIfKeyRefused", "startAgain", "forget"],
  },
  stopPartial: {
    subtitle: "hue:runtime.timeout.title",
    tone: "error",
    pill: { tone: "error", label: "hue:page.pill.failed" },
    lead: null,
    cells: selectedAreaCells,
    detail: ({ t, hue }) => (
      <HueRepairNote
        error
        title={t("hue:runtime.partialStop.title")}
        sub={t("hue:runtime.partialStop.body")}
        code={hue.runtimeStatus?.code ?? null}
      />
    ),
    actions: ["stopHue", "forceForget"],
  },
  gateBlocked: {
    subtitle: "hue:runtime.checklist.title",
    tone: null,
    pill: { tone: "warn", label: "hue:page.pill.awaiting" },
    lead: null,
    cells: (ctx) => [...selectedAreaCells(ctx), PROTOCOL_CELL],
    // Validate lives in the footer.
    detail: ({ t, hue }) => (
      <div className="lm-hue-checklist" data-testid="hue-gate-blocked">
        <div className="lm-hue-checklist-title">{t("hue:runtime.checklist.title")}</div>
        {hue.isReadinessStale ? (
          <div className="lm-hue-checklist-item">
            <IconInfo />
            <span>{t("hue:runtime.checklist.revalidate")}</span>
          </div>
        ) : null}
        <StatusCodeDetail code={hue.runtimeStatus?.code} />
      </div>
    ),
    actions: ["validate", "changeArea"],
  },
  authError: {
    subtitle: "hue:credential.needsRepair",
    tone: "error",
    pill: { tone: "error", label: "hue:page.pill.authError" },
    // Shown before the cells. Its one action, Re-pair, sits in the footer.
    lead: ({ t, hue }) => (
      <HueRepairNote
        error
        title={t("hue:credential.needsRepair")}
        sub={t("hue:credential.repairHint")}
        code={hue.status?.code ?? null}
        testId="hue-auth-error"
      />
    ),
    cells: (ctx) => [
      ...selectedAreaCells(ctx),
      { label: "hue:card.cellCredential", value: ctx.t("hue:card.cellCredentialInvalid"), tone: "error" },
    ],
    detail: null,
    actions: ["repair", "forget"],
  },
  pairingFailed: {
    subtitle: "hue:wizard.pairingFailed",
    tone: "error",
    pill: { tone: "error", label: "hue:page.pill.failed" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ t, pairingErrorKey }) => (
      <>
        <HuePairingSteps t={t} failed />
        {pairingErrorKey ? (
          <HueRepairNote
            error
            title={t("hue:wizard.pairingFailed")}
            sub={t(pairingErrorKey)}
            testId="hue-pairing-failed-reason"
          />
        ) : null}
      </>
    ),
    actions: ["repair", "forget"],
  },
  offline: {
    subtitle: "hue:bridge.unreachable",
    tone: "offline",
    pill: { tone: "error", label: "hue:bridge.unreachable" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ t }) => (
      <div className="lm-hue-offline">
        <div className="lm-hue-offline-title">{t("hue:wizard.offlineReasonsTitle")}</div>
        <div className="lm-hue-offline-item">{t("hue:wizard.offlineReason1")}</div>
        <div className="lm-hue-offline-item">{t("hue:wizard.offlineReason2")}</div>
        <div className="lm-hue-offline-item">{t("hue:wizard.offlineReason3")}</div>
      </div>
    ),
    actions: ["rediscover", "differentIp", "forget"],
  },
  pairing: {
    subtitle: "hue:wizard.pairingStep",
    tone: "ghost",
    pill: { tone: "warn", label: "hue:page.pill.awaiting" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ t }) => <HuePairingSteps t={t} failed={false} />,
    actions: ["cancel"],
  },
  pairingLinkButton: {
    subtitle: "hue:wizard.pairingStep",
    tone: "ghost",
    pill: { tone: "warn", label: "hue:page.pill.awaiting" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ t }) => (
      <div className="lm-hue-wait" role="status" aria-live="polite">
        <span className="lm-hue-wait-sp" aria-hidden="true" />
        <span>{t("hue:pair.linkButtonHint")}</span>
      </div>
    ),
    actions: ["cancel"],
  },
  pairingTimedOut: {
    subtitle: "hue:pair.timedOutTitle",
    tone: "warn",
    pill: { tone: "warn", label: "hue:page.pill.timedOut" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ t }) => <HueRepairNote title={t("hue:pair.timedOutTitle")} sub={t("hue:pair.timedOutHint")} />,
    actions: ["tryPairAgain", "cancel"],
  },
  pairingDeferred: {
    subtitle: "hue:pair.deferredTitle",
    tone: "warn",
    pill: { tone: "warn", label: "hue:page.pill.wait" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ t, pairingErrorKey }) =>
      pairingErrorKey ? (
        <HueRepairNote title={t("hue:pair.deferredTitle")} sub={t(pairingErrorKey)} testId="hue-pairing-deferred" />
      ) : null,
    actions: ["tryPairAgain", "cancel"],
  },
  areaSelect: {
    subtitle: "hue:wizard.areaStep",
    tone: "ghost",
    pill: { tone: "ok", label: "hue:page.pill.paired" },
    lead: null,
    cells: NO_CELLS,
    detail: ({ hue, areaChoice }) => <HueAreaPicker areaGroups={hue.areaGroups} choice={areaChoice} />,
    actions: ["confirmArea", "refreshAreas"],
  },
} satisfies Record<HueBridgeCardState, HueCardView>;

/**
 * "Change area" lays the list over whichever state offered it: the state keeps
 * its header, lead and cells; the list and its two ways out replace the detail
 * and the footer.
 */
export function withAreaChange(view: HueCardView): HueCardView {
  return {
    ...view,
    detail: ({ hue, areaChoice }) => <HueAreaPicker areaGroups={hue.areaGroups} choice={areaChoice} />,
    actions: ["confirmArea", "cancelAreaChange"],
  };
}
