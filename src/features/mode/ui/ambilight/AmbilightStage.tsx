import { useTranslation } from "react-i18next";

import { setPreference, usePreference } from "@/features/persistence/preferences";
import type { LightingSmoothingPreset } from "@/shared/contracts/lighting";
import type { AmbilightPayload } from "@/shared/contracts/mode";
import { Callout } from "@/shared/ui/Callout/Callout";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";
import { Stage, StageChoice, StageGrid, StageRow } from "@/shared/ui/Stage/Stage";
import { Toggle } from "@/shared/ui/Toggle/Toggle";

const SMOOTHING_LABEL = {
  subtle: "lights:signal.smoothing.subtle",
  moderate: "lights:signal.smoothing.moderate",
  intense: "lights:signal.smoothing.intense",
} as const satisfies Record<LightingSmoothingPreset, string>;
const SMOOTHING_ORDER = Object.keys(SMOOTHING_LABEL) as LightingSmoothingPreset[];

interface AmbilightStageProps {
  ambilight: AmbilightPayload;
  /** The compact window: brightness and smoothing only; the fine settings are on Lights. */
  dense?: boolean;
  disabled?: boolean;
  /** Adalight carries no brightness byte, so the slider is shown locked with the reason. */
  brightnessLocked?: boolean;
  brightnessTitle?: string;
  /** The serial link's frame ceiling, said when it holds the strip back. */
  linkNote?: string | null;
  onChange: (next: AmbilightPayload) => void;
}

const pct = (v: number | null | undefined, fallback: number) => Math.round((v ?? fallback) * 100);

/** Ambilight's stage: how bright and how vivid the screen's colours land, and how fast they follow. */
export function AmbilightStage({
  ambilight,
  dense = false,
  disabled = false,
  brightnessLocked = false,
  brightnessTitle,
  linkNote = null,
  onChange,
}: AmbilightStageProps) {
  const { t } = useTranslation();
  // Read at boot with the other preferences, so the stage opens on the stored choice.
  const smoothing = usePreference("lightingIntensityPreset");
  const brightness = pct(ambilight.brightness, 1);
  const saturation = pct(ambilight.saturation, 1);
  const blackBorder = ambilight.blackBorderDetection ?? false;

  return (
    <Stage dense={dense} testId="ambilight-stage">
      <StageGrid>
        <RangeRow
          variant="stage"
          label={t("lights:signal.profile.brightness")}
          valueLabel={`${brightness}%`}
          min={0}
          max={100}
          step={1}
          value={brightness}
          disabled={disabled || brightnessLocked}
          title={brightnessTitle}
          onChange={(v) => onChange({ ...ambilight, brightness: v / 100 })}
          testId="ambilight-brightness"
        />
        {dense ? null : (
          <RangeRow
            variant="stage"
            label={t("lights:signal.profile.saturation")}
            valueLabel={`${saturation}%`}
            min={50}
            max={200}
            step={1}
            value={saturation}
            disabled={disabled}
            onChange={(v) => onChange({ ...ambilight, saturation: v / 100 })}
            testId="ambilight-saturation"
          />
        )}
        <StageRow label={t("lights:signal.smoothing.title")}>
          <StageChoice
            ariaLabel={t("lights:signal.smoothing.title")}
            value={smoothing}
            disabled={disabled}
            onChange={(next) => void setPreference("lightingIntensityPreset", next)}
            options={SMOOTHING_ORDER.map((preset) => ({
              value: preset,
              label: t(SMOOTHING_LABEL[preset]),
              testId: `smoothing-${preset}`,
            }))}
          />
        </StageRow>
        {dense ? null : (
          <StageRow
            label={
              <>
                {t("lights:signal.profile.blackBorder")}
                <InfoTip label={t("lights:signal.profile.blackBorderTipLabel")}>
                  {t("lights:signal.profile.blackBorderTip")}
                </InfoTip>
              </>
            }
          >
            <Toggle
              checked={blackBorder}
              disabled={disabled}
              label={t("lights:signal.profile.blackBorder")}
              onChange={(next) => onChange({ ...ambilight, blackBorderDetection: next })}
              data-testid="ambilight-black-border"
            />
          </StageRow>
        )}
      </StageGrid>
      {/* role="status", never "alert": the ceiling is derived once at worker start, a steady fact. */}
      {linkNote ? <Callout tone="warning">{linkNote}</Callout> : null}
    </Stage>
  );
}
