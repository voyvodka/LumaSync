import { type MouseEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "@/shared/lib/cx";
import { useSideScroll } from "@/shared/lib/useSideScroll";
import { IconLed, IconTv } from "@/shared/ui/icons";

import type { ViewLight } from "../../model/viewLights";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { usePaletteKeys } from "../../state/usePaletteKeys";
import { HueAreaNote, type PaletteHueArea } from "../dock/HueAreaNote";
import { Disc } from "../dock/InspectorParts";
import styles from "./ViewLightRow.module.css";
import { useViewLightLabel } from "./viewLightLabel";

export interface ViewLightRowProps {
  lights: readonly ViewLight[];
  /** The Hue side of the room; an area not ready says why in place of the lights. */
  hue: PaletteHueArea | null;
  onSelect: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}

/** The room's lights as one row of chips that scrolls sideways, then the strips and the screen
 *  with a hint beside them. One tab stop; the arrows walk the chips. */
export function ViewLightRow({ lights, hue: hueArea, onSelect }: ViewLightRowProps) {
  const { t } = useTranslation();
  const hue = lights.filter((light) => light.kind === "hue");
  const rest = lights.filter((light) => light.kind !== "hue");
  const { tileProps } = usePaletteKeys([hue.map((light) => light.id), rest.map((light) => light.id)]);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLSpanElement | null>(null);
  const areaMissing = hueArea !== null && hueArea.state.kind !== "ready";
  const more = useSideScroll(stripRef, hue.map((light) => light.id).join(","), undefined);

  return (
    <div className={styles.page} role="toolbar" aria-label={t("roomMap:view.lights.label")} data-testid="view-lights">
      <div ref={stripRef} className={cx(styles.row, styles.scroll)} data-more={more}>
        {areaMissing && hue.length === 0 ? (
          <HueAreaNote hue={hueArea} noteRef={noteRef} />
        ) : hue.length === 0 ? (
          <span className={styles.hint}>{t("roomMap:view.lights.noHue")}</span>
        ) : (
          hue.map((light) => (
            <Chip
              key={light.id}
              light={light}
              {...tileProps(light.id)}
              onClick={(event) => onSelect(light.id, event)}
            />
          ))
        )}
      </div>
      <div className={styles.row}>
        {rest.map((light) => (
          <Chip key={light.id} light={light} {...tileProps(light.id)} onClick={(event) => onSelect(light.id, event)} />
        ))}
        <span className={styles.hint}>{t("roomMap:view.lights.hint")}</span>
      </div>
    </div>
  );
}

function Chip({
  light,
  onClick,
  ...roving
}: {
  light: ViewLight;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
} & ReturnType<ReturnType<typeof usePaletteKeys>["tileProps"]>) {
  const describe = useViewLightLabel();
  const label = describe(light);
  return (
    <button
      type="button"
      className={cx(styles.chip, light.ghost && styles.ghost)}
      aria-label={label}
      title={label}
      data-testid={`view-light-${light.id}`}
      data-light-id={light.id}
      onClick={onClick}
      onFocus={(event) => {
        roving.onFocus();
        event.currentTarget.scrollIntoView?.({ inline: "nearest", block: "nearest", behavior: "auto" });
      }}
      tabIndex={roving.tabIndex}
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
    >
      <span className={styles.mark} aria-hidden="true">
        {light.kind === "hue" ? (
          <Disc ghost={light.ghost} />
        ) : (
          <span style={{ color: light.kind === "tv" ? TYPE_DOT_COLOR.tv : TYPE_DOT_COLOR.usb, display: "grid" }}>
            {light.kind === "tv" ? <IconTv /> : <IconLed />}
          </span>
        )}
      </span>
      {light.zone && <span className={styles.zone} style={{ background: light.zone.colour }} aria-hidden="true" />}
      <span className={styles.name}>{light.name}</span>
    </button>
  );
}
