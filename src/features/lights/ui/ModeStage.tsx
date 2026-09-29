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
} from "@/shared/contracts/mode";
import { Stage, StageNote } from "@/shared/ui/Stage/Stage";
import { StageSwap } from "./StageSwap";

interface ModeStageProps {
  mode: LightingModeConfig;
  /** The compact window's stages: fewer settings, a denser surface. */
  dense?: boolean;
  disabled: boolean;
  brightnessLocked: boolean;
  brightnessTitle?: string;
  linkNote?: string | null;
  onModeChange: (next: LightingModeConfig) => void;
}

/** The running mode's stage, passed on to the next one when the mode changes. */
export function ModeStage({
  mode,
  dense = false,
  disabled,
  brightnessLocked,
  brightnessTitle,
  linkNote = null,
  onModeChange,
}: ModeStageProps) {
  const { t } = useTranslation();
  const kind = mode.kind;
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
      case LIGHTING_MODE_KIND.EFFECT:
        return (
          <EffectControls
            {...locks}
            variant={dense ? "compact" : "full"}
            effect={normalizeEffectPayload(mode.effect)}
            onChange={(effect) => onModeChange({ kind: LIGHTING_MODE_KIND.EFFECT, effect })}
          />
        );
      default:
        return (
          <Stage dense={dense} testId="off-stage">
            <StageNote>{t("lights:stage.off")}</StageNote>
          </Stage>
        );
    }
  })();

  return (
    <StageSwap stageKey={kind} order={MODE_KIND_ORDER.indexOf(kind)}>
      {stage}
    </StageSwap>
  );
}
