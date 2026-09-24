/**
 * LedChipTypePicker — LED chip type selector.
 *
 * A 2-tile radio group that lets the user choose between WS2812B GRB
 * (3-byte, default, backward-compat) and SK6812 RGBW (4-byte with
 * host-side W = min(R,G,B) extraction).
 *
 * Selection is persisted to `shellStore.selectedChipType`. The save alone
 * reaches a running strip: Rust re-applies the mode once a setting it reads
 * is saved, and rebuilds the encoder from the stored chip type
 * (docs/architecture/lighting-transaction.md).
 *
 * Constraint: SK6812 RGBW + Adalight profile is a firmware mismatch.
 * When the user selects SK6812 while Adalight is active, a warning line
 * is surfaced (the Rust fallback path already handles this gracefully by
 * falling back to WS2812B encoding — this is a visible hint only).
 *
 * When a LumaSync firmware has reported its pixel layout (connect or health
 * check) and the selected chip type sends the other one, the selected tile is
 * marked. Never switched for the user: the marker is the whole response.
 *
 * Accessibility:
 *   - `role="radiogroup"` + per-tile `role="radio"` + `aria-checked`.
 *   - Arrow-key navigation between tiles (Left/Right, Up/Down).
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  FIRMWARE_PIXEL_LAYOUT,
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  pixelLayoutForChipType,
  type FirmwarePixelLayout,
  type FirmwareProfile,
  type LedChipType,
} from "@/shared/contracts/device";
import { useAdvertisedPixelLayout } from "@/features/device/useAdvertisedFirmwareProfile";
import { shellStore } from "@/features/persistence/shellStore";

const DEFAULT_CHIP_TYPE: LedChipType = LED_CHIP_TYPE.WS2812B_GRB;

interface ChipTileProps {
  chipType: LedChipType;
  label: string;
  description: string;
  warning?: string;
  /** The connected firmware expects the other pixel layout. */
  firmwareMismatch?: string;
  checked: boolean;
  onSelect: (chipType: LedChipType) => void;
  onKeyNavigate: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  tileRef: React.RefObject<HTMLButtonElement | null>;
}

function ChipTile({
  chipType,
  label,
  description,
  warning,
  firmwareMismatch,
  checked,
  onSelect,
  onKeyNavigate,
  tileRef,
}: ChipTileProps) {
  return (
    <button
      ref={tileRef}
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={() => onSelect(chipType)}
      onKeyDown={onKeyNavigate}
      data-chip-type={chipType}
      data-mismatched={firmwareMismatch ? "true" : undefined}
      className="lm-strip-tile"
    >
      <span className="lm-strip-tile-name">{label}</span>
      <span className="lm-strip-tile-desc is-data">{description}</span>
      {warning ? (
        <span className="lm-strip-tile-note is-warn">
          <span aria-hidden="true">⚠ </span>
          {warning}
        </span>
      ) : null}
      {firmwareMismatch ? (
        <span className="lm-strip-tile-note is-warn">
          <span aria-hidden="true">⚠ </span>
          {firmwareMismatch}
        </span>
      ) : null}
    </button>
  );
}

export interface LedChipTypePickerProps {
  /** Initial chip type from shellStore — parent hydrates before first paint. */
  initialChipType?: LedChipType;
  /**
   * Current firmware profile — used to surface the SK6812+Adalight
   * compatibility warning. Does not block selection.
   */
  firmwareProfile?: FirmwareProfile;
  /**
   * Test override for the layout the firmware reported; production mounts
   * leave it `undefined` and subscribe to the firmware bus.
   */
  advertisedPixelLayout?: FirmwarePixelLayout;
  /** Fired after persistence completes so parents can react. */
  onChipTypeChange?: (next: LedChipType) => void;
}

export function LedChipTypePicker({
  initialChipType,
  firmwareProfile,
  advertisedPixelLayout: advertisedFromProp,
  onChipTypeChange,
}: LedChipTypePickerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descId = useId();
  const advertisedFromBus = useAdvertisedPixelLayout();
  const advertisedLayout = advertisedFromProp ?? advertisedFromBus;
  const [chipType, setChipType] = useState<LedChipType>(
    initialChipType ?? DEFAULT_CHIP_TYPE,
  );

  const ws2812bRef = useRef<HTMLButtonElement | null>(null);
  const sk6812Ref = useRef<HTMLButtonElement | null>(null);

  // Defensive hydrate when parent does not supply initialChipType.
  useEffect(() => {
    if (initialChipType) return;
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (state.selectedChipType) setChipType(state.selectedChipType);
      })
      .catch((error) => {
        console.error("[LumaSync] LedChipTypePicker hydrate failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [initialChipType]);

  const handleSelect = useCallback(
    (next: LedChipType) => {
      if (next === chipType) return;
      setChipType(next);
      void shellStore
        .save({ selectedChipType: next })
        .catch((error) => {
          console.error(
            "[LumaSync] shellStore.save(selectedChipType) failed:",
            error,
          );
        });
      onChipTypeChange?.(next);
    },
    [chipType, onChipTypeChange],
  );

  const handleKeyNavigate = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        const next: LedChipType =
          chipType === LED_CHIP_TYPE.WS2812B_GRB
            ? LED_CHIP_TYPE.SK6812_RGBW
            : LED_CHIP_TYPE.WS2812B_GRB;
        handleSelect(next);
        const targetRef = next === LED_CHIP_TYPE.SK6812_RGBW ? sk6812Ref : ws2812bRef;
        targetRef.current?.focus();
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        const next: LedChipType =
          chipType === LED_CHIP_TYPE.SK6812_RGBW
            ? LED_CHIP_TYPE.WS2812B_GRB
            : LED_CHIP_TYPE.SK6812_RGBW;
        handleSelect(next);
        const targetRef = next === LED_CHIP_TYPE.SK6812_RGBW ? sk6812Ref : ws2812bRef;
        targetRef.current?.focus();
      }
    },
    [chipType, handleSelect],
  );

  const showAdalightWarning =
    chipType === LED_CHIP_TYPE.SK6812_RGBW &&
    firmwareProfile === FIRMWARE_PROFILE.ADALIGHT;

  const firmwareMismatch =
    advertisedLayout !== undefined && advertisedLayout !== pixelLayoutForChipType(chipType)
      ? advertisedLayout === FIRMWARE_PIXEL_LAYOUT.RGBW
        ? t("lights:led.chipType.firmwareExpectsRgbw")
        : t("lights:led.chipType.firmwareExpectsRgb")
      : undefined;

  return (
    <div className="lm-strip-setting">
      <h3 className="lm-strip-setting-h" id={titleId}>{t("lights:led.chipType.label")}</h3>
      <p className="lm-strip-setting-desc" id={descId}>{t("lights:led.chipType.description")}</p>
      {/* The radiogroup is the one named container: a group around it with
          the same name had every screen reader say it twice. */}
      <div role="radiogroup" aria-labelledby={titleId} aria-describedby={descId} className="lm-strip-tiles">
        <ChipTile
          chipType={LED_CHIP_TYPE.WS2812B_GRB}
          label={t("lights:led.chipType.options.ws2812b")}
          description={t("lights:led.chipType.details.ws2812b")}
          checked={chipType === LED_CHIP_TYPE.WS2812B_GRB}
          firmwareMismatch={chipType === LED_CHIP_TYPE.WS2812B_GRB ? firmwareMismatch : undefined}
          onSelect={handleSelect}
          onKeyNavigate={handleKeyNavigate}
          tileRef={ws2812bRef}
        />
        <ChipTile
          chipType={LED_CHIP_TYPE.SK6812_RGBW}
          label={t("lights:led.chipType.options.sk6812rgbw")}
          description={t("lights:led.chipType.details.sk6812rgbw")}
          warning={
            showAdalightWarning
              ? t("lights:led.chipType.sk6812AdalightWarning")
              : undefined
          }
          checked={chipType === LED_CHIP_TYPE.SK6812_RGBW}
          firmwareMismatch={chipType === LED_CHIP_TYPE.SK6812_RGBW ? firmwareMismatch : undefined}
          onSelect={handleSelect}
          onKeyNavigate={handleKeyNavigate}
          tileRef={sk6812Ref}
        />
      </div>
    </div>
  );
}
