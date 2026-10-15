import { useTranslation } from "react-i18next";

import { resolveStripDensity, resolveStripMountHeight, type UsbStripPlacement } from "@/shared/contracts/roomMap";
import { IconLed } from "@/shared/ui/icons";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { StateWord } from "@/shared/ui/StateWord/StateWord";

import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { DecimalField } from "../DecimalField";
import { Actions, FieldRow, InspectorRows, Mark, Meta, RowLink, Spacer, Status, Title } from "../dock/InspectorParts";
import { GlyphHeight } from "./fieldGlyphs";

/**
 * Whether the strip's port is the one connected. `unknown` ⇒ no port snapshot has loaded yet, and
 * the slot stays empty rather than guessing.
 */
export type UsbStripConnectionStatus = "connected" | "disconnected" | "unknown";

export function UsbStripInspector({
  strip,
  connectionStatus,
  port,
  onUpdate,
  onMove,
  onToggleLock,
  onDuplicate,
  onDelete,
  onClose,
  onManage,
  height,
  onStickToWall,
  fitTo,
  onFitLength,
  onAddCorner,
  onStraighten,
}: {
  strip: UsbStripPlacement;
  connectionStatus: UsbStripConnectionStatus;
  /** The port the strip is on, or the connected one for a strip that names none. */
  port: string | null;
  onUpdate: (patch: Partial<UsbStripPlacement>) => void;
  /** Moves the strip by its start point; the end keeps its offset. */
  onMove: (x: number, y: number) => void;
  onToggleLock: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
  onManage?: () => void;
  /** The height field, where the 3D room draws the strip by it (not behind the screen). */
  height?: { placeholder: string; max: number };
  /** Lays the strip along its nearest wall; absent when it is there already or cannot move. */
  onStickToWall?: () => void;
  /** The length its LEDs at its density make, in metres, when the drawn run is not that long. */
  fitTo?: number;
  onFitLength?: () => void;
  /** Bends the strip in the middle of its longest leg; absent at the cap or when it cannot move. */
  onAddCorner?: () => void;
  /** Takes its corners out; absent when it has none. */
  onStraighten?: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!strip.locked;

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <span style={{ color: TYPE_DOT_COLOR.usb, display: "grid" }}>
              <IconLed />
            </span>
          </Mark>
          <Title>{t("roomMap:objectPanel.ledLabel", { count: String(strip.ledCount) })}</Title>
          <Status>
            {connectionStatus !== "unknown" && (
              <StateWord tone={connectionStatus === "connected" ? "live" : "idle"}>
                {connectionStatus === "connected"
                  ? t("roomMap:inspector.usbConnectedFallback")
                  : t("roomMap:inspector.usbConnectionDisconnected")}
              </StateWord>
            )}
            {port && <Meta>{port}</Meta>}
          </Status>
          {fitTo !== undefined && onFitLength && (
            <RowLink onClick={onFitLength}>{t("roomMap:inspector.usbFitLength", { metres: fitTo.toFixed(2) })}</RowLink>
          )}
          {onStickToWall && <RowLink onClick={onStickToWall}>{t("roomMap:inspector.usbStickToWall")}</RowLink>}
          {onAddCorner && <RowLink onClick={onAddCorner}>{t("roomMap:inspector.usbAddCorner")}</RowLink>}
          {onStraighten && <RowLink onClick={onStraighten}>{t("roomMap:inspector.usbStraighten")}</RowLink>}
          {onManage && <RowLink onClick={onManage}>{t("roomMap:inspector.usbManage")}</RowLink>}
          <Spacer />
          <Actions locked={locked} onToggleLock={onToggleLock} onDuplicate={onDuplicate} onDelete={onDelete} onClose={onClose} />
        </>
      }
      second={
        <>
          <FieldRow>
            <DecimalField
              first
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
            <DecimalField
              optional
              label={t("roomMap:inspector.usbDensityLabel")}
              value={resolveStripDensity(strip)}
              placeholder="–"
              decimals={0}
              step={1}
              min={1}
              max={300}
              unit="LED/m"
              disabled={locked}
              onCommit={(ledsPerMeter) => onUpdate({ ledsPerMeter: ledsPerMeter ?? null })}
            />
            {height && (
              <DecimalField
                optional
                label={t("roomMap:inspector.usbHeightLabel")}
                prefix={<GlyphHeight />}
                value={resolveStripMountHeight(strip)}
                placeholder={height.placeholder}
                min={0}
                max={height.max}
                unit="m"
                disabled={locked}
                onCommit={(mountHeightMeters) => onUpdate({ mountHeightMeters: mountHeightMeters ?? null })}
              />
            )}
          </FieldRow>
          <InfoTip label={t("common:hintFor", { label: t("roomMap:inspector.usbLedCountLabel") })}>
            {[t("roomMap:inspector.usbHint"), t("roomMap:inspector.usbDensityHint"), t("roomMap:inspector.usbCornerHint"), height ? t("roomMap:inspector.usbHeightHint") : null].filter(Boolean).join(" ")}
          </InfoTip>
        </>
      }
    />
  );
}
