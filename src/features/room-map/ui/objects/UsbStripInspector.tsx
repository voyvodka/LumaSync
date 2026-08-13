import { useTranslation } from "react-i18next";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import { Header, InspectorNumberField } from "./InspectorPrimitives";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

/**
 * Connection status the inspector renders next to the LED count.
 * `unknown` ⇒ no port snapshot has loaded yet (initial mount race).
 * `connected` / `disconnected` come from `useUsbConnectionStatus`.
 */
export type UsbStripConnectionStatus = "connected" | "disconnected" | "unknown";

export function UsbStripInspector({
  strip,
  connectionStatus,
  connectedPort,
  onUpdate,
  onToggleLock,
  onManage,
}: {
  strip: UsbStripPlacement;
  connectionStatus: UsbStripConnectionStatus;
  connectedPort: string | null;
  onUpdate: (patch: Partial<UsbStripPlacement>) => void;
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

      <InspectorNumberField
        id={`usb-leds-${strip.stripId}`}
        label={t("roomMap:inspector.usbLedCountLabel")}
        value={strip.ledCount}
        step={1}
        min={1}
        max={1000}
        disabled={locked}
        onCommit={(next) => onUpdate({ ledCount: Math.round(next) })}
      />

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
