/**
 * LedChipTypePicker — v1.5 G3 LED chip type selector.
 *
 * A 2-tile radio group that lets the user choose between WS2812B GRB
 * (3-byte, default, backward-compat) and SK6812 RGBW (4-byte with
 * host-side W = min(R,G,B) extraction).
 *
 * Selection is persisted to `shellStore.selectedChipType`. On next
 * `connect_serial_port` the chip type is read from the store and forwarded
 * to `SerialSink::with_chip_type` on the Rust side.
 *
 * Constraint: SK6812 RGBW + Adalight profile is a firmware mismatch.
 * When the user selects SK6812 while Adalight is active, a tooltip warning
 * is surfaced (the Rust fallback path already handles this gracefully by
 * falling back to WS2812B encoding — this is a visible hint only).
 *
 * Accessibility:
 *   - `role="radiogroup"` + per-tile `role="radio"` + `aria-checked`.
 *   - Arrow-key navigation between tiles (Left/Right, Up/Down).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  type FirmwareProfile,
  type LedChipType,
} from "../../../../shared/contracts/device";
import { shellStore } from "../../../persistence/shellStore";

const DEFAULT_CHIP_TYPE: LedChipType = LED_CHIP_TYPE.WS2812B_GRB;

interface ChipTileProps {
  chipType: LedChipType;
  label: string;
  description: string;
  warning?: string;
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
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 14px",
        borderRadius: 8,
        border: `1px solid ${checked ? "rgba(255, 176, 32, 0.4)" : "#252b34"}`,
        background: checked ? "rgba(255, 176, 32, 0.08)" : "#0a0c0f",
        color: checked ? "var(--lm-amber, #ffb020)" : "#eaeef4",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: "-0.005em",
          color: checked ? "var(--lm-amber, #ffb020)" : "#eaeef4",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
          fontSize: 10,
          color: "#8a94a3",
          lineHeight: 1.45,
        }}
      >
        {description}
      </div>
      {warning && (
        <div
          style={{
            fontFamily: "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
            fontSize: 9.5,
            color: checked ? "var(--lm-amber, #ffb020)" : "#4d5564",
            letterSpacing: "0.02em",
            marginTop: 2,
          }}
          title={warning}
        >
          {"⚠ "}{warning}
        </div>
      )}
    </button>
  );
}

export interface LedChipTypePickerProps {
  /** Initial chip type from shellStore — parent hydrates before first paint. */
  initialChipType?: LedChipType;
  /**
   * Current firmware profile — used to surface the SK6812+Adalight
   * compatibility warning tooltip. Does not block selection.
   */
  firmwareProfile?: FirmwareProfile;
  /** Fired after persistence completes so parents can react. */
  onChipTypeChange?: (next: LedChipType) => void;
}

export function LedChipTypePicker({
  initialChipType,
  firmwareProfile,
  onChipTypeChange,
}: LedChipTypePickerProps) {
  const { t } = useTranslation("common");
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

  return (
    <section className="lm-settings-group">
      <div className="lm-settings-group-h">
        <span className="t">{t("ledSettings.chipType.label")}</span>
        <span className="sub">{t("ledSettings.chipType.description")}</span>
      </div>
      <div
        role="radiogroup"
        aria-label={t("ledSettings.chipType.label")}
        style={{
          display: "flex",
          gap: 10,
          padding: 14,
          flexWrap: "wrap",
        }}
      >
        <ChipTile
          chipType={LED_CHIP_TYPE.WS2812B_GRB}
          label={t("ledSettings.chipType.options.ws2812b")}
          description="WS2812B · GRB · 3 bytes/pixel"
          checked={chipType === LED_CHIP_TYPE.WS2812B_GRB}
          onSelect={handleSelect}
          onKeyNavigate={handleKeyNavigate}
          tileRef={ws2812bRef}
        />
        <ChipTile
          chipType={LED_CHIP_TYPE.SK6812_RGBW}
          label={t("ledSettings.chipType.options.sk6812rgbw")}
          description="SK6812 · RGBW · 4 bytes/pixel · W=min(R,G,B)"
          warning={
            showAdalightWarning
              ? t("ledSettings.chipType.sk6812AdalightWarning")
              : undefined
          }
          checked={chipType === LED_CHIP_TYPE.SK6812_RGBW}
          onSelect={handleSelect}
          onKeyNavigate={handleKeyNavigate}
          tileRef={sk6812Ref}
        />
      </div>
    </section>
  );
}
