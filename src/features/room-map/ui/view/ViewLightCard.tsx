import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "@/shared/lib/cx";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconLed, IconTv } from "@/shared/ui/icons";
import { StateWord } from "@/shared/ui/StateWord/StateWord";

import type { ViewLight } from "../../model/viewLights";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import type { UsbStripConnectionStatus } from "../objects/UsbStripInspector";
import { IconBack, IconIdentify } from "../dock/dockIcons";
import { Disc, InspectorRows, Mark, Meta, Note, RowLink, Status } from "../dock/InspectorParts";
import styles from "./ViewLightCard.module.css";
import { useViewLightFacts } from "./viewLightLabel";

export interface ViewLightCardProps {
  light: ViewLight;
  /** How it reads now: the bridge for a Hue light, the strip for a strip or a screen's backlight. */
  connection?: UsbStripConnectionStatus;
  port?: string | null;
  /** How bright the room's lights are, 0–1; null while they are off. */
  level: number | null;
  /** A Hue light blinks through the bridge; a strip, or a screen through its backlight, flashes white. */
  canIdentify: boolean;
  identifying: boolean;
  /** The last identify of this light failed: the short reason. */
  identifyFailure: string | null;
  /** Why identify is not offered, when it is not. */
  identifyUnavailable: string | null;
  onBack: (event: MouseEvent<HTMLButtonElement>) => void;
  onIdentify: () => void;
  onEdit: () => void;
}

/** One light, opened from the row or from the room: what it is, a way to find it in the room, and
 *  the way to its place on the plan. The second row's end is held for its power switch, and its
 *  facts give way to a brightness bar, so neither moves anything when they arrive. */
export function ViewLightCard({
  light,
  connection,
  port = null,
  level,
  canIdentify,
  identifying,
  identifyFailure,
  identifyUnavailable,
  onBack,
  onIdentify,
  onEdit,
}: ViewLightCardProps) {
  const { t } = useTranslation();
  const facts = useViewLightFacts()(light);

  return (
    <InspectorRows
      first={
        <>
          <IconButton
            className={styles.back}
            label={t("roomMap:view.back")}
            icon={<IconBack />}
            data-dock-first=""
            data-testid="view-card-back"
            onClick={onBack}
          />
          <Mark>
            {light.kind === "hue" ? (
              <Disc ghost={light.ghost} />
            ) : (
              <span style={{ color: light.kind === "tv" ? TYPE_DOT_COLOR.tv : TYPE_DOT_COLOR.usb, display: "grid" }}>
                {light.kind === "tv" ? <IconTv /> : <IconLed />}
              </span>
            )}
          </Mark>
          <span className={styles.name} title={light.name} data-testid="view-card-name">
            {light.name}
          </span>
          <IconButton
            className={cx(styles.action, identifying && styles.busy)}
            label={identifying ? t("hue:channelMap.identifying") : t("roomMap:view.identify")}
            title={canIdentify ? (identifying ? t("hue:channelMap.identifying") : t("roomMap:view.identifyHint")) : (identifyUnavailable ?? undefined)}
            icon={<IconIdentify />}
            aria-busy={identifying || undefined}
            aria-disabled={!canIdentify || undefined}
            data-testid="view-card-identify"
            onClick={canIdentify && !identifying ? onIdentify : undefined}
          />
          <RowLink onClick={onEdit}>{t("roomMap:view.edit")}</RowLink>
        </>
      }
      second={
        <>
          <span className={styles.facts}>
            {light.ghost ? (
              <Note tone="warning" title={t("roomMap:inspector.hueGhostShort")}>
                {t("roomMap:inspector.hueGhostShort")}
              </Note>
            ) : identifyFailure ? (
              <Note tone="warning" title={identifyFailure}>
                {identifyFailure}
              </Note>
            ) : (
              <Status>
                {connection && connection !== "unknown" && (
                  <StateWord tone={connection === "connected" ? "live" : "idle"}>
                    {connection === "connected"
                      ? t("roomMap:inspector.usbConnectedFallback")
                      : connection === "unlinked"
                        ? t("roomMap:inspector.usbNoPort")
                        : t("roomMap:inspector.usbConnectionDisconnected")}
                  </StateWord>
                )}
                <Meta>
                  {[
                    light.kind === "usb" ? port : facts,
                    level === null || connection === "disconnected" || connection === "unlinked"
                      ? t("roomMap:view.hover.off")
                      : t("roomMap:view.hover.on", { percent: Math.round(level * 100) }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
              </Status>
            )}
          </span>
          <span className={styles.slot} aria-hidden="true" />
        </>
      }
    />
  );
}
