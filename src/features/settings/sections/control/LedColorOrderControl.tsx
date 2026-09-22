import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_LED_COLOR_ORDER,
  LED_COLOR_ORDER,
  type LedColorOrder,
} from "@/shared/contracts/device";
import { shellStore } from "@/features/persistence/shellStore";
import { normalizeColorOrder } from "@/features/mode/model/contracts";

import {
  useColorOrderIdentify,
  type ColorOrderIdentifyDeps,
  type IdentifyFailure,
  type IdentifyState,
  type ProbeAnswer,
} from "./useColorOrderIdentify";

const ORDER_OPTIONS: LedColorOrder[] = Object.values(LED_COLOR_ORDER);

const FAILURE_KEYS = {
  other: "lights:led.colorOrder.identify.otherHint",
  notSending: "lights:led.colorOrder.identify.errors.notSending",
  noCalibration: "lights:led.colorOrder.identify.errors.noCalibration",
  startFailed: "lights:led.colorOrder.identify.errors.startFailed",
  saveFailed: "lights:led.colorOrder.identify.errors.saveFailed",
  stopFailed: "lights:led.colorOrder.identify.errors.stopFailed",
} as const satisfies Record<IdentifyFailure, string>;

const ANSWERS = [
  { answer: "r", key: "lights:led.colorOrder.identify.answer.red" },
  { answer: "g", key: "lights:led.colorOrder.identify.answer.green" },
  { answer: "b", key: "lights:led.colorOrder.identify.answer.blue" },
  { answer: "other", key: "lights:led.colorOrder.identify.answer.other" },
] as const satisfies readonly { answer: ProbeAnswer; key: string }[];

const COLOR_ANSWER_KEYS = {
  r: "lights:led.colorOrder.identify.answer.red",
  g: "lights:led.colorOrder.identify.answer.green",
  b: "lights:led.colorOrder.identify.answer.blue",
} as const;

function orderCode(order: LedColorOrder): string {
  return order.toUpperCase();
}

/** Where focus belongs for a state, so every step change lands somewhere useful. */
function stepKey(state: IdentifyState): string {
  return state.step === "probe" ? `probe-${state.slot}` : state.step;
}

export interface LedColorOrderControlProps {
  /** `"wled"` hides the control: WLED sets its own order on the device. */
  localTransport: "serial" | "wled" | null;
  /** Retune the running output; the control has already saved the order. */
  onColorOrderChange?: (next: LedColorOrder) => void;
  /** Injectable for tests. */
  start?: ColorOrderIdentifyDeps["start"];
  /** Injectable for tests. */
  stop?: ColorOrderIdentifyDeps["stop"];
}

export function LedColorOrderControl({
  localTransport,
  onColorOrderChange,
  start,
  stop,
}: LedColorOrderControlProps) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<LedColorOrder>(DEFAULT_LED_COLOR_ORDER);
  const [manualSaveFailed, setManualSaveFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setOrder(normalizeColorOrder(state.ledColorOrder) ?? DEFAULT_LED_COLOR_ORDER);
      })
      .catch((error) => {
        console.error("[LumaSync] LedColorOrderControl hydrate failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: LedColorOrder) => {
    await shellStore.save({ ledColorOrder: next });
  }, []);

  const onApplied = useCallback(
    (next: LedColorOrder) => {
      setOrder(next);
      onColorOrderChange?.(next);
    },
    [onColorOrderChange],
  );

  const identify = useColorOrderIdentify({ start, stop, save, onApplied, current: order });
  const { state } = identify;
  const flowOpen = state.step !== "idle";

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const hintId = `${baseId}-hint`;
  const manualId = `${baseId}-manual`;

  const identifyButtonRef = useRef<HTMLButtonElement | null>(null);
  const stepHeadingRef = useRef<HTMLParagraphElement | null>(null);
  const wasOpenRef = useRef(false);
  const currentStepKey = stepKey(state);

  useEffect(() => {
    if (flowOpen) {
      stepHeadingRef.current?.focus();
    } else if (wasOpenRef.current) {
      identifyButtonRef.current?.focus();
    }
    wasOpenRef.current = flowOpen;
  }, [flowOpen, currentStepKey]);

  const handleManualChange = useCallback(
    (value: string) => {
      const next = normalizeColorOrder(value);
      if (!next || next === order) return;
      setManualSaveFailed(false);
      void save(next)
        .then(() => onApplied(next))
        .catch((error) => {
          console.error("[LumaSync] shellStore.save(ledColorOrder) failed:", error);
          setManualSaveFailed(true);
        });
    },
    [onApplied, order, save],
  );

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (state.step === "verify") identify.keep();
      else identify.cancel();
    },
    [identify, state.step],
  );

  if (localTransport === "wled") {
    return (
      <section className="lm-settings-group lm-color-order" aria-labelledby={titleId}>
        <div className="lm-settings-group-h">
          <span className="t" id={titleId}>{t("lights:led.colorOrder.label")}</span>
        </div>
        <p className="lm-color-order-note">{t("lights:led.colorOrder.wledHint")}</p>
      </section>
    );
  }

  const canIdentify = localTransport === "serial";

  return (
    <section className="lm-settings-group lm-color-order" aria-labelledby={titleId}>
      <div className="lm-settings-group-h">
        <span className="t" id={titleId}>{t("lights:led.colorOrder.label")}</span>
      </div>
      <div className="lm-color-order-body">
        <p className="lm-color-order-note">{t("lights:led.colorOrder.description")}</p>

        <div className="lm-color-order-current">
          <span className="lm-color-order-code" aria-label={t("lights:led.colorOrder.currentAria", { order: orderCode(order) })}>
            {orderCode(order)}
          </span>
          {order === DEFAULT_LED_COLOR_ORDER ? (
            <span className="lm-color-order-tag">{t("lights:led.colorOrder.defaultTag")}</span>
          ) : null}
          <button
            ref={identifyButtonRef}
            type="button"
            className="lm-color-order-btn is-primary lm-color-order-identify"
            onClick={identify.begin}
            disabled={!canIdentify || flowOpen}
            aria-describedby={canIdentify ? undefined : hintId}
          >
            {t("lights:led.colorOrder.identify.button")}
          </button>
        </div>
        {!canIdentify ? (
          <p id={hintId} className="lm-color-order-note">
            {t("lights:led.colorOrder.identify.needsStrip")}
          </p>
        ) : null}

        {state.step !== "idle" ? (
          <div
            className="lm-color-order-flow"
            role="group"
            aria-labelledby={`${baseId}-flow-title`}
            onKeyDown={handlePanelKeyDown}
          >
            <p id={`${baseId}-flow-title`} className="lm-color-order-flow-title">
              {t("lights:led.colorOrder.identify.title")}
            </p>
            <IdentifyStep
              state={state}
              headingRef={stepHeadingRef}
              onAnswer={identify.answer}
              onApply={identify.apply}
              onKeep={identify.keep}
              onUndo={identify.undo}
              onCancel={identify.cancel}
            />
          </div>
        ) : null}

        <div className="lm-color-order-manual">
          <label htmlFor={manualId}>{t("lights:led.colorOrder.manualLabel")}</label>
          <select
            id={manualId}
            className="lm-settings-select"
            value={order}
            disabled={flowOpen}
            onChange={(event) => handleManualChange(event.target.value)}
          >
            {ORDER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {orderCode(option)}
              </option>
            ))}
          </select>
        </div>
        {manualSaveFailed ? (
          <p role="alert" className="lm-color-order-error">
            {t("lights:led.colorOrder.identify.errors.saveFailed")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

interface IdentifyStepProps {
  state: Exclude<IdentifyState, { step: "idle" }>;
  headingRef: React.RefObject<HTMLParagraphElement | null>;
  onAnswer: (answer: ProbeAnswer) => void;
  onApply: () => void;
  onKeep: () => void;
  onUndo: () => void;
  onCancel: () => void;
}

function IdentifyStep({
  state,
  headingRef,
  onAnswer,
  onApply,
  onKeep,
  onUndo,
  onCancel,
}: IdentifyStepProps) {
  const { t } = useTranslation();

  if (state.step === "probe") {
    return (
      <>
        <p ref={headingRef} tabIndex={-1} className="lm-color-order-step">
          <span className="lm-color-order-step-n">
            {t("lights:led.colorOrder.identify.step", { current: state.slot + 1, total: 3 })}
          </span>{" "}
          {t("lights:led.colorOrder.identify.prompt")}
        </p>
        <div className="lm-color-order-answers" aria-busy={state.pending}>
          {ANSWERS.map(({ answer, key }) => (
            <button
              key={answer}
              type="button"
              className={`lm-color-order-btn lm-color-order-answer${answer === "other" ? " is-other" : ""}`}
              onClick={() => onAnswer(answer)}
              disabled={state.pending}
            >
              <span className={`lm-color-order-swatch is-${answer}`} aria-hidden="true" />
              {t(key)}
            </button>
          ))}
        </div>
        {state.duplicate ? (
          <p role="alert" className="lm-color-order-error">
            {t("lights:led.colorOrder.identify.duplicate", {
              color: t(COLOR_ANSWER_KEYS[state.duplicate]),
            })}
          </p>
        ) : null}
        <div className="lm-color-order-actions">
          <button type="button" className="lm-color-order-btn" onClick={onCancel}>
            {t("lights:led.colorOrder.identify.cancel")}
          </button>
        </div>
      </>
    );
  }

  if (state.step === "result") {
    return (
      <>
        <p ref={headingRef} tabIndex={-1} className="lm-color-order-step">
          {t("lights:led.colorOrder.identify.result", { order: orderCode(state.order) })}
        </p>
        <div className="lm-color-order-actions">
          <button
            type="button"
            className="lm-color-order-btn is-primary"
            onClick={onApply}
            disabled={state.pending}
            aria-busy={state.pending}
          >
            {t("lights:led.colorOrder.identify.apply", { order: orderCode(state.order) })}
          </button>
          <button type="button" className="lm-color-order-btn" onClick={onCancel} disabled={state.pending}>
            {t("lights:led.colorOrder.identify.cancel")}
          </button>
        </div>
      </>
    );
  }

  if (state.step === "verify") {
    return (
      <>
        <p ref={headingRef} tabIndex={-1} className="lm-color-order-step">
          {t("lights:led.colorOrder.identify.verify", { order: orderCode(state.order) })}
        </p>
        <p className="lm-color-order-note">{t("lights:led.colorOrder.identify.verifyHint")}</p>
        <div className="lm-color-order-actions">
          <button
            type="button"
            className="lm-color-order-btn is-primary"
            onClick={onKeep}
            disabled={state.pending}
          >
            {t("lights:led.colorOrder.identify.keep")}
          </button>
          <button
            type="button"
            className="lm-color-order-btn"
            onClick={onUndo}
            disabled={state.pending}
            aria-busy={state.pending}
          >
            {t("lights:led.colorOrder.identify.undo", { order: orderCode(state.previous) })}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p ref={headingRef} tabIndex={-1} role="alert" className="lm-color-order-step is-error">
        {t(FAILURE_KEYS[state.reason])}
      </p>
      <div className="lm-color-order-actions">
        {state.reason === "stopFailed" ? (
          <button type="button" className="lm-color-order-btn is-primary" onClick={onApply}>
            {t("lights:led.colorOrder.identify.retry")}
          </button>
        ) : null}
        <button type="button" className="lm-color-order-btn" onClick={onCancel}>
          {t("lights:led.colorOrder.identify.close")}
        </button>
      </div>
    </>
  );
}
