import { useTranslation } from "react-i18next";

import { AmbilightStage } from "@/features/mode/ui/ambilight/AmbilightStage";
import { EffectControls } from "@/features/mode/ui/effects/EffectControls";
import { SolidStage } from "@/features/mode/ui/solid/SolidStage";
import { MODE_KIND_ORDER } from "@/features/mode/model/modeKinds";
import {
  DEFAULT_SOLID_COLOR,
  LIGHTING_MODE_KIND,
  normalizeAmbilightPayload,
  normalizeEffectPayload,
  type LightingModeConfig,
  type LitModeKind,
} from "@/shared/contracts/mode";
import { StageSwap } from "./StageSwap";
import styles from "./ModeStage.module.css";

interface ModeStageProps {
  mode: LightingModeConfig;
  /** The compact window's stages: fewer settings, a denser surface. */
  dense?: boolean;
  disabled: boolean;
  brightnessLocked: boolean;
  brightnessTitle?: string;
  linkNote?: string | null;
  onModeChange: (next: LightingModeConfig) => void;
  /** The mode shown, dimmed, while the lights are off: what the power button brings back. */
  lastLit: LitModeKind;
  /** "Turn on" on the dimmed stage; absent where turning on is locked. */
  onTurnOn?: () => void;
}

/**
 * The running mode's stage, passed on to the next one when the mode changes. While the lights are
 * off it stays: the last lit mode's stage, dimmed and out of reach, with a way to turn them on — so
 * turning the lights off and on moves nothing on the page.
 */
export function ModeStage({
  mode,
  dense = false,
  disabled,
  brightnessLocked,
  brightnessTitle,
  linkNote = null,
  onModeChange,
  lastLit,
  onTurnOn,
}: ModeStageProps) {
  const { t } = useTranslation();
  const off = mode.kind === LIGHTING_MODE_KIND.OFF;
  const kind: LitModeKind = mode.kind === LIGHTING_MODE_KIND.OFF ? lastLit : mode.kind;
  const locks = { disabled, brightnessLocked, brightnessTitle };

  const stage = (() => {
    switch (kind) {
      case LIGHTING_MODE_KIND.AMBILIGHT:
        return (
          <AmbilightStage
            {...locks}
            dense={dense}
            ambilight={normalizeAmbilightPayload(mode.ambilight)}
            linkNote={linkNote}
            onChange={(ambilight) => onModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight })}
          />
        );
      case LIGHTING_MODE_KIND.SOLID:
        return (
          <SolidStage
            {...locks}
            dense={dense}
            solid={mode.solid ?? DEFAULT_SOLID_COLOR}
            onCommit={(solid) => onModeChange({ kind: LIGHTING_MODE_KIND.SOLID, solid })}
          />
        );
      default:
        return (
          <EffectControls
            {...locks}
            variant={dense ? "compact" : "full"}
            effect={normalizeEffectPayload(mode.effect)}
            onChange={(effect) => onModeChange({ kind: LIGHTING_MODE_KIND.EFFECT, effect })}
          />
        );
    }
  })();

  return (
    <StageSwap stageKey={kind} order={MODE_KIND_ORDER.indexOf(kind)}>
      <div className={styles.holder} data-dormant={off || undefined} data-testid={off ? "off-stage" : undefined}>
        <div className={styles.stage} inert={off || undefined}>
          {stage}
        </div>
        {off ? (
          <div className={styles.dormant}>
            <span>{t("lights:stage.dormant")}</span>
            {onTurnOn ? (
              <button type="button" className={styles.turnOn} onClick={onTurnOn} data-testid="stage-turn-on">
                {t("lights:stage.turnOn")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </StageSwap>
  );
}
