import { useTranslation } from "react-i18next";

import { usePresence } from "@/shared/lib/usePresence";
import { IconPower } from "@/shared/ui/icons";

import { useSceneEdit } from "@/features/scenes/state/scenesStore";

import { AmbilightStage } from "@/features/mode/ui/ambilight/AmbilightStage";
import { EffectControls } from "@/features/mode/ui/effects/EffectControls";
import { SolidStage } from "@/features/mode/ui/solid/SolidStage";
import { MODE_KIND_ORDER, modeKind } from "@/features/mode/model/modeKinds";
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
  // The veil over the dimmed stage fades in and, when the lights come back on, out with the dimming.
  const veil = usePresence(off, 200);
  // A scene being made or edited is shaped with its settings, not its choice of effect.
  const editingScene = useSceneEdit() !== null;
  const locks = { disabled, brightnessLocked, brightnessTitle };
  const LitIcon = modeKind(lastLit).Icon;

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
            galleryRow={editingScene}
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
        {veil.mounted ? (
          <div
            className={styles.veil}
            data-leaving={veil.leaving || undefined}
            data-ghost-skip
            inert={veil.leaving || undefined}
          >
            <div className={styles.dormant}>
              <span className={styles.powerMark} aria-hidden>
                <IconPower />
              </span>
              <span className={styles.dormantText}>{t("lights:stage.dormant")}</span>
              {/* Always there, disabled while it cannot: a button that went away mid-press read as a
                  stall and moved what was under the pointer. */}
              <button
                type="button"
                className={styles.turnOn}
                disabled={!onTurnOn}
                onClick={(event) => {
                  // The veil goes with the dimming: focus moves to the power switch, which now says on.
                  event.currentTarget
                    .closest("[data-lights]")
                    ?.querySelector<HTMLElement>("[data-power]")
                    ?.focus({ preventScroll: true });
                  onTurnOn?.();
                }}
                data-testid="stage-turn-on"
              >
                <LitIcon />
                {t("lights:power.turnOn", { mode: t(modeKind(lastLit).labelKey) })}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </StageSwap>
  );
}
