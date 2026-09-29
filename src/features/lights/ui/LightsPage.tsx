import { useTranslation } from "react-i18next";

import type { LocalSink } from "@/features/device/localSink";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import { MODE_KINDS } from "@/features/mode/model/modeKinds";
import { outputAvailability } from "@/features/mode/model/outputAvailability";
import { MODE_GUARD_REASONS, type ModeGuardReason } from "@/features/mode/state/modeGuard";
import { ModeStrip } from "@/features/mode/ui/ModeStrip";
import { roomAwareStatus } from "@/features/room-map/model/roomAware";
import { Scenes } from "@/features/scenes/ui/Scenes";
import { useRuntimeHealth } from "@/features/telemetry/runtimeHealthSource";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import {
  DEFAULT_SOLID_COLOR,
  LIGHTING_MODE_KIND,
  normalizeAmbilightPayload,
  normalizeEffectPayload,
  normalizeLightingModeConfig,
  type LightingModeConfig,
} from "@/shared/contracts/mode";
import { hasSerialLinkBudget, type RuntimeHealth } from "@/shared/contracts/telemetry";
import { rgbToHex } from "@/shared/lib/color";
import { shallowEqual } from "@/shared/lib/store";
import { ModeStage } from "./ModeStage";
import { OutputsRail } from "./OutputsRail";
import { useLightsModel } from "./useLightsModel";
import styles from "./LightsPage.module.css";

const selectLinkBudget = (health: RuntimeHealth) => ({
  linkConstrained: health.linkConstrained,
  linkMaxFps: health.linkMaxFps,
});

export interface LightsPageProps {
  mode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  /** Any local output — serial strip or WLED panel — is bound. */
  localOutputConnected: boolean;
  /** Which one, so the row can name it rather than always saying USB. */
  localSink: LocalSink | null;
  hueConfigured: boolean;
  /** The shell boot has settled; until then `hueConfigured: false` is not yet known. */
  bootstrapDone?: boolean;
  hueReachable?: boolean;
  /** What the last bridge probe found; picks the unavailable row's wording. */
  hueProbeVerdict?: HueProbeVerdict | null;
  hueStreaming: boolean;
  /** Hue session owned but the backend is retrying the bridge; overrides `hueStreaming`. */
  hueReconnecting?: boolean;
  /** The backend reports the Hue stream Failed: the retries are over. */
  hueStreamFailed?: boolean;
  calibration?: LedCalibrationConfig;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  /** The rail's "+": outputs are added on Devices. */
  onAddOutput?: () => void;
}

/**
 * Lights: the modes, the scenes, the running mode's stage, and where the light goes. The stage
 * column is capped and centred so a wide window does not stretch it.
 */
export function LightsPage({
  mode,
  outputTargets,
  localOutputConnected,
  localSink,
  hueConfigured,
  bootstrapDone = true,
  hueReachable = true,
  hueProbeVerdict = null,
  hueStreaming,
  hueReconnecting = false,
  hueStreamFailed = false,
  calibration,
  modeLockReason,
  isModeTransitioning = false,
  onModeChange,
  onOutputTargetsChange,
  onAddOutput,
}: LightsPageProps) {
  const { t } = useTranslation();
  const { brightnessLocked, brightnessTitle, tvAnchor } = useLightsModel();
  // Why the mode buttons are dim — calibration, no output, still checking — is said by the shell
  // notice queue, not here (docs/architecture/ui-and-shell.md).
  const calibrationLocked = modeLockReason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  const selectorLocked = calibrationLocked || isModeTransitioning;
  // Without a reachable sink an activated mode starts a worker with nowhere to send frames; a
  // bridge still being checked is not one yet either, but it is not "missing".
  const availability = outputAvailability({
    localOutputConnected,
    hueConfigured,
    hueReachable,
    hueProbeVerdict,
    bootstrapDone,
  });
  const nonOffLocked = selectorLocked || availability !== "ready";
  const normalized = normalizeLightingModeConfig(mode);
  const kind = normalized.kind;
  const solid = normalized.solid ?? DEFAULT_SOLID_COLOR;
  const effect = normalizeEffectPayload(normalized.effect);
  const ambilight = normalizeAmbilightPayload(normalized.ambilight);
  const brightnessPct = (v: number) => Math.round(v * 100);
  const totalLeds = calibration?.totalLeds;

  // Pushed by the worker, not polled. Gated on the flag, never on `linkMaxFps < 30`: the 0
  // sentinel means "no serial link this session".
  const linkBudget = useRuntimeHealth(selectLinkBudget, shallowEqual);
  const linkNote =
    kind === LIGHTING_MODE_KIND.AMBILIGHT &&
    outputTargets.includes("usb") &&
    hasSerialLinkBudget(linkBudget) &&
    linkBudget.linkConstrained
      ? `${t("lights:signal.linkBudget.constrained", { fps: Math.round(linkBudget.linkMaxFps) })} ${t("lights:signal.linkBudget.hint")}`
      : null;

  const roomAware = roomAwareStatus(tvAnchor, outputTargets, {
    configured: hueConfigured,
    reachable: hueReachable,
    verdict: hueProbeVerdict,
  });

  return (
    <div className={styles.page}>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <ModeStrip
            variant="full"
            value={kind}
            // Off is never locked by the calibration: lights left running behind a lock could not
            // be switched off otherwise.
            isDisabled={(k) => (k === LIGHTING_MODE_KIND.OFF ? isModeTransitioning : nonOffLocked)}
            subtitles={{
              [LIGHTING_MODE_KIND.OFF]: t("lights:mode.off.subtitle"),
              [LIGHTING_MODE_KIND.AMBILIGHT]: t("lights:mode.ambilight.subtitle", {
                brightness: brightnessPct(ambilight.brightness),
              }),
              [LIGHTING_MODE_KIND.SOLID]:
                solid.kelvin != null
                  ? t("lights:mode.solid.subtitleWhite", { kelvin: solid.kelvin, brightness: brightnessPct(solid.brightness) })
                  : t("lights:mode.solid.subtitle", {
                      hex: rgbToHex(solid).toUpperCase(),
                      brightness: brightnessPct(solid.brightness),
                    }),
              [LIGHTING_MODE_KIND.EFFECT]: t("lights:mode.effect.subtitle", {
                name: t(`lights:effect.names.${effect.id}`),
                brightness: brightnessPct(effect.brightness),
              }),
            }}
            onSelect={(next) => onModeChange(MODE_KINDS[next].config({ solid: { ...solid }, ambilight, effect }))}
          />
          <Scenes mode={normalized} disabled={nonOffLocked} onApply={onModeChange} />
          <ModeStage
            mode={normalized}
            disabled={calibrationLocked}
            brightnessLocked={brightnessLocked}
            brightnessTitle={brightnessTitle}
            linkNote={linkNote}
            onModeChange={onModeChange}
          />
        </div>
      </div>
      <OutputsRail
        outputTargets={outputTargets}
        localOutputConnected={localOutputConnected}
        localSink={localSink}
        totalLeds={totalLeds}
        hueConfigured={hueConfigured}
        hueReachable={hueReachable}
        hueProbeVerdict={hueProbeVerdict}
        bootstrapDone={bootstrapDone}
        hueStreaming={hueStreaming}
        hueReconnecting={hueReconnecting}
        hueStreamFailed={hueStreamFailed}
        roomAware={roomAware}
        isModeTransitioning={isModeTransitioning}
        onOutputTargetsChange={onOutputTargetsChange}
        onAddOutput={onAddOutput}
      />
    </div>
  );
}
