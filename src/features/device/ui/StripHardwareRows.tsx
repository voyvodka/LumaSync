import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_LED_COLOR_ORDER,
  FIRMWARE_PIXEL_LAYOUT,
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  LED_COLOR_ORDER,
  pixelLayoutForChipType,
  type FirmwarePixelLayout,
  type FirmwareProfile,
  type LedChipType,
  type LedColorOrder,
} from "@/shared/contracts/device";
import type { StripHardware } from "@/shared/contracts/strips";
import { shellStore } from "@/features/persistence/shellStore";
import {
  useColorOrderIdentify,
  type ColorOrderIdentifyDeps,
  type IdentifyFailure,
  type ProbeAnswer,
} from "../state/useColorOrderIdentify";
import { withHardwareOf } from "@/features/strips/model/stripWrites";
import { ChoiceStrip } from "@/shared/ui/ChoiceStrip/ChoiceStrip";
import { ConfirmPopover } from "@/shared/ui/ConfirmPopover/ConfirmPopover";
import { PickerList } from "@/shared/ui/PickerList/PickerList";
import { Popover } from "@/shared/ui/Popover/Popover";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";

import styles from "./StripPage.module.css";

const PROFILE_LABEL = {
  [FIRMWARE_PROFILE.LUMASYNC_V1]: "lights:led.firmwareProfile.lumasyncV1Label",
  [FIRMWARE_PROFILE.ADALIGHT]: "lights:led.firmwareProfile.adalightLabel",
} as const satisfies Record<FirmwareProfile, string>;

const CHIP_LABEL = {
  [LED_CHIP_TYPE.WS2812B_GRB]: "device:strip.chip.ws2812b",
  [LED_CHIP_TYPE.SK6812_RGBW]: "device:strip.chip.sk6812rgbw",
} as const satisfies Record<LedChipType, string>;

const ignore = () => undefined;

const ORDERS: readonly LedColorOrder[] = Object.values(LED_COLOR_ORDER);

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

const COLOR_KEYS = {
  r: "lights:led.colorOrder.identify.answer.red",
  g: "lights:led.colorOrder.identify.answer.green",
  b: "lights:led.colorOrder.identify.answer.blue",
} as const;

/** Saves hardware on strip `stripId`. */
export async function saveHardware(stripId: string, patch: Partial<StripHardware>): Promise<void> {
  try {
    await shellStore.update((state) => withHardwareOf(state, stripId, patch));
  } catch (error) {
    console.error("[LumaSync] saving the strip's hardware failed:", error);
    throw error;
  }
}

interface FirmwareRowProps {
  profile: FirmwareProfile;
  /** What the controller answered with at its last connect or check; `undefined` when unknown. */
  advertised: FirmwareProfile | undefined;
  /** The saved "do not ask" choice for picking against what the controller reports. */
  dontAsk: boolean;
  onChange: (next: FirmwareProfile) => void;
}

/** The protocol the controller's firmware speaks. Picking against what it reported asks first. */
export function FirmwareRow({ profile, advertised, dontAsk, onChange }: FirmwareRowProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [asking, setAsking] = useState<FirmwareProfile | null>(null);
  const label = t("device:strip.row.firmware");
  const name = (value: FirmwareProfile) => t(PROFILE_LABEL[value]);
  const mismatch = advertised !== undefined && advertised !== profile;

  const pick = (value: string) => {
    const next = value as FirmwareProfile;
    if (next === profile) return;
    if (advertised !== undefined && next !== advertised && !dontAsk) setAsking(next);
    else onChange(next);
  };

  return (
    <SettingRow
      label={label}
      hint={t("device:strip.hint.firmware")}
      testId="strip-firmware"
      control={
        <div ref={anchorRef}>
          <ChoiceStrip
            label={label}
            value={profile}
            options={Object.values(FIRMWARE_PROFILE).map((value) => ({ value, label: name(value) }))}
            onChange={pick}
            testIdPrefix="strip-firmware-"
          />
        </div>
      }
    >
      <Reveal open={mismatch}>
        {mismatch && advertised !== undefined ? (
          <RowNote tone="error" testId="strip-firmware-note">
            {t("device:strip.firmware.mismatch", { advertised: name(advertised), chosen: name(profile) })}
          </RowNote>
        ) : null}
      </Reveal>
      {asking !== null && advertised !== undefined ? (
        <ConfirmPopover
          open
          anchorRef={anchorRef}
          label={label}
          text={t("device:strip.firmware.confirm", { advertised: name(advertised), chosen: name(asking) })}
          confirmLabel={t("device:strip.firmware.confirmYes", { chosen: name(asking) })}
          cancelLabel={t("device:strip.firmware.cancel")}
          danger
          onConfirm={() => {
            setAsking(null);
            onChange(asking);
          }}
          onCancel={() => setAsking(null)}
          testId="strip-firmware-confirm"
          confirmTestId="strip-firmware-confirm-yes"
        />
      ) : null}
    </SettingRow>
  );
}

interface ChipRowProps {
  chip: LedChipType;
  profile: FirmwareProfile;
  /** The bytes per LED the controller said it expects; `undefined` when unknown. */
  advertisedLayout: FirmwarePixelLayout | undefined;
  onChange: (next: LedChipType) => void;
}

/** The LEDs the strip is built from, which decides how many bytes each one takes. */
export function ChipRow({ chip, profile, advertisedLayout, onChange }: ChipRowProps) {
  const { t } = useTranslation();
  const label = t("device:strip.row.chip");
  const adalightRgbw = chip === LED_CHIP_TYPE.SK6812_RGBW && profile === FIRMWARE_PROFILE.ADALIGHT;
  const layoutMismatch = advertisedLayout !== undefined && advertisedLayout !== pixelLayoutForChipType(chip);
  const note = adalightRgbw
    ? t("lights:led.chipType.sk6812AdalightWarning")
    : layoutMismatch
      ? t(
          advertisedLayout === FIRMWARE_PIXEL_LAYOUT.RGBW
            ? "lights:led.chipType.firmwareExpectsRgbw"
            : "lights:led.chipType.firmwareExpectsRgb",
        )
      : null;
  return (
    <SettingRow
      label={label}
      hint={t("device:strip.hint.chip")}
      testId="strip-chip"
      control={
        <ChoiceStrip
          label={label}
          value={chip}
          options={Object.values(LED_CHIP_TYPE).map((value) => ({ value, label: t(CHIP_LABEL[value]) }))}
          onChange={(value) => {
            if (value !== chip) onChange(value as LedChipType);
          }}
          testIdPrefix="strip-chip-"
        />
      }
    >
      <Reveal open={note !== null}>{note !== null ? <RowNote tone="error">{note}</RowNote> : null}</Reveal>
    </SettingRow>
  );
}

interface ColorOrderRowProps {
  stripId: string;
  order: LedColorOrder;
  /** Identify lights the strip, so it needs one connected. */
  canIdentify: boolean;
  /** The order was saved; the strips re-read on save, so a page need not pass it. */
  onChange?: (next: LedColorOrder) => void;
  identifyDeps?: Pick<ColorOrderIdentifyDeps, "start" | "stop">;
}

/**
 * The order the strip takes its colours in. The value opens a list to pick from; Identify lights
 * one colour at a time and asks which it was, beside the button, and works it out.
 */
export function ColorOrderRow({ stripId, order, canIdentify, onChange, identifyDeps }: ColorOrderRowProps) {
  const { t } = useTranslation();
  const listId = useId();
  const valueRef = useRef<HTMLButtonElement | null>(null);
  const identifyRef = useRef<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const code = (value: LedColorOrder) => value.toUpperCase();

  const save = (next: LedColorOrder) => saveHardware(stripId, { colorOrder: next });
  const identify = useColorOrderIdentify({
    ...identifyDeps,
    save,
    onApplied: onChange ?? ignore,
    current: order,
  });
  const { state } = identify;
  const flowOpen = state.step !== "idle";

  return (
    <SettingRow
      label={t("device:strip.row.colorOrder")}
      hint={t("device:strip.hint.colorOrder")}
      testId="strip-color-order"
      value={
        <button
          ref={valueRef}
          type="button"
          className={styles.valueButton}
          aria-expanded={picking}
          aria-controls={picking ? listId : undefined}
          aria-label={t("lights:led.colorOrder.currentAria", { order: code(order) })}
          disabled={flowOpen}
          onClick={() => setPicking((open) => !open)}
          data-testid="strip-color-order-value"
        >
          {code(order)}
          <svg aria-hidden viewBox="0 0 12 12" className={styles.chevron} data-open={picking || undefined}>
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      }
      control={
        // Identify lights the strip: with none connected it is not offered rather than greyed.
        !canIdentify && !flowOpen ? null : (
        <RowButton
          ref={identifyRef}
          aria-expanded={flowOpen}
          onClick={flowOpen ? (state.step === "verify" ? identify.keep : identify.cancel) : identify.begin}
          data-testid="strip-color-order-identify"
        >
          {t("device:strip.action.identify")}
        </RowButton>
        )
      }
    >
      <PickerList
        open={picking}
        onClose={() => setPicking(false)}
        anchorRef={valueRef}
        side="below"
        id={listId}
        label={t("device:strip.row.colorOrder")}
        width="fit"
        items={ORDERS}
        itemKey={(value) => value}
        renderItem={(value) => code(value)}
        selectedIndex={ORDERS.indexOf(order)}
        onPick={(index) => {
          setPicking(false);
          const next = ORDERS[index] ?? DEFAULT_LED_COLOR_ORDER;
          if (next === order) return;
          setSaveFailed(false);
          save(next)
            .then(() => onChange?.(next))
            .catch(() => setSaveFailed(true));
        }}
      />
      <Reveal open={saveFailed}>
        {saveFailed ? <RowNote tone="error">{t("lights:led.colorOrder.identify.errors.saveFailed")}</RowNote> : null}
      </Reveal>
      <Popover
        open={flowOpen}
        onClose={state.step === "verify" ? identify.keep : identify.cancel}
        anchorRef={identifyRef}
        side="below"
        width={300}
        label={t("lights:led.colorOrder.identify.title")}
        role="dialog"
      >
        <IdentifySteps identify={identify} />
      </Popover>
    </SettingRow>
  );
}

/** One step of Identify at a time; focus lands on each step's first answer. */
function IdentifySteps({ identify }: { identify: ReturnType<typeof useColorOrderIdentify> }) {
  const { t } = useTranslation();
  const { state } = identify;
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const stepKey = state.step === "probe" ? `probe-${state.slot}` : state.step;
  // biome-ignore lint/correctness/useExhaustiveDependencies: stepKey moves focus to the new step
  useEffect(() => {
    firstRef.current?.focus();
  }, [stepKey]);

  if (state.step === "idle") return null;
  if (state.step === "probe") {
    return (
      <div className={styles.question} data-testid="strip-identify-probe">
        <p className={styles.questionText}>
          <span className={styles.step}>
            {t("lights:led.colorOrder.identify.step", { current: state.slot + 1, total: 3 })}
          </span>
          {t("lights:led.colorOrder.identify.prompt")}
        </p>
        <div className={styles.answers} aria-busy={state.pending || undefined}>
          {ANSWERS.map(({ answer, key }, index) => (
            <RowButton
              key={answer}
              ref={index === 0 ? firstRef : undefined}
              disabled={state.pending}
              onClick={() => identify.answer(answer)}
            >
              <span className={styles.swatch} data-color={answer} aria-hidden="true" />
              {t(key)}
            </RowButton>
          ))}
        </div>
        {state.duplicate ? (
          <p className={styles.questionError} role="alert">
            {t("lights:led.colorOrder.identify.duplicate", { color: t(COLOR_KEYS[state.duplicate]) })}
          </p>
        ) : null}
      </div>
    );
  }
  if (state.step === "result") {
    const order = state.order.toUpperCase();
    return (
      <div className={styles.question}>
        <p className={styles.questionText}>{t("lights:led.colorOrder.identify.result", { order })}</p>
        <div className={styles.questionActions}>
          <RowButton onClick={identify.cancel} disabled={state.pending}>
            {t("lights:led.colorOrder.identify.cancel")}
          </RowButton>
          <RowButton ref={firstRef} primary aria-busy={state.pending || undefined} onClick={identify.apply}>
            {t("lights:led.colorOrder.identify.apply", { order })}
          </RowButton>
        </div>
      </div>
    );
  }
  if (state.step === "verify") {
    return (
      <div className={styles.question}>
        <p className={styles.questionText}>
          {t("lights:led.colorOrder.identify.verify", { order: state.order.toUpperCase() })}
        </p>
        <p className={styles.questionHint}>{t("lights:led.colorOrder.identify.verifyHint")}</p>
        <div className={styles.questionActions}>
          <RowButton onClick={identify.undo} aria-busy={state.pending || undefined}>
            {t("lights:led.colorOrder.identify.undo", { order: state.previous.toUpperCase() })}
          </RowButton>
          <RowButton ref={firstRef} primary disabled={state.pending} onClick={identify.keep}>
            {t("lights:led.colorOrder.identify.keep")}
          </RowButton>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.question}>
      <p className={styles.questionError} role="alert">
        {t(FAILURE_KEYS[state.reason])}
      </p>
      <div className={styles.questionActions}>
        <RowButton ref={firstRef} onClick={identify.cancel}>
          {t("lights:led.colorOrder.identify.close")}
        </RowButton>
        {state.reason === "stopFailed" ? (
          <RowButton primary onClick={identify.apply}>
            {t("lights:led.colorOrder.identify.retry")}
          </RowButton>
        ) : null}
      </div>
    </div>
  );
}

