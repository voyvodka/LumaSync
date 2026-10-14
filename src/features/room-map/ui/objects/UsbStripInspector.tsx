import { useTranslation } from "react-i18next";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import { Header } from "./InspectorPrimitives";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { DecimalField, FieldPair } from "../DecimalField";

/**
 * Connection status the inspector renders next to the LED count.
 * `unknown` ⇒ no port snapshot has loaded yet (initial mount race).
 * `connected` / `disconnected` come from the local-output registry.
 */
export type UsbStripConnectionStatus = "connected" | "disconnected" | "unknown";

export function UsbStripInspector({
  strip,
  connectionStatus,
  connectedPort,
  onUpdate,
  onMove,
  onToggleLock,
  onManage,
}: {
  strip: UsbStripPlacement;
  connectionStatus: UsbStripConnectionStatus;
  connectedPort: string | null;
  onUpdate: (patch: Partial<UsbStripPlacement>) => void;
  /** Moves the strip by its start point; the end keeps its offset. */
  onMove: (x: number, y: number) => void;
  onToggleLock: () => void;
  onManage?: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!strip.locked;

  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeUsb")}
        name={t("roomMap:objectPanel.ledLabel", { count: String(strip.ledCount) })}
        dotColor={TYPE_DOT_COLOR.usb}
      />

      {/* Linked port + live status badge */}
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label">
          {t("roomMap:inspector.usbPortLabel")}
        </span>
        <span
          className={`lm-room-dock-conn-chip lm-room-dock-conn-chip--${connectionStatus}`}
          role="status"
          aria-live="polite"
        >
          <span className="lm-room-dock-conn-chip-dot" aria-hidden />
          <span className="lm-room-dock-conn-chip-tx">
            {connectionStatus === "connected"
              ? (connectedPort ?? t("roomMap:inspector.usbConnectedFallback"))
              : connectionStatus === "disconnected"
                ? t("roomMap:inspector.usbConnectionDisconnected")
                : t("roomMap:inspector.usbConnectionUnknown")}
          </span>
        </span>
      </div>

      <FieldPair>
        <DecimalField
          label={t("roomMap:inspector.xLabel")}
          prefix="X"
          value={strip.startX}
          unit="m"
          disabled={locked}
          onCommit={(x) => onMove(x, strip.startY)}
        />
        <DecimalField
          label={t("roomMap:inspector.yLabel")}
          prefix="Y"
          value={strip.startY}
          unit="m"
          disabled={locked}
          onCommit={(y) => onMove(strip.startX, y)}
        />
      </FieldPair>
      <FieldPair>
        <DecimalField
          label={t("roomMap:inspector.usbLedCountLabel")}
          value={strip.ledCount}
          decimals={0}
          step={1}
          min={1}
          max={1000}
          unit="LED"
          disabled={locked}
          onCommit={(ledCount) => onUpdate({ ledCount })}
        />
        <span />
      </FieldPair>

      <div className="lm-room-dock-field-actions">
        <button
          type="button"
          className="lm-room-dock-inspect-action"
          onClick={onToggleLock}
          aria-pressed={locked}
        >
          {locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
        </button>
        {onManage ? (
          <button
            type="button"
            className="lm-room-dock-inspect-action"
            onClick={onManage}
          >
            {t("roomMap:inspector.usbManage")}
          </button>
        ) : null}
      </div>

      <p className="lm-room-dock-field-hint">{t("roomMap:inspector.usbHint")}</p>
    </>
  );
}
