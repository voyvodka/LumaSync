import { memo, useCallback } from "react";

import { useHueShellStatus, type HueShellStatus } from "@/features/hue/state/hueShellStatus";
import { modeKind } from "@/features/mode/model/modeKinds";
import { outputAvailability } from "@/features/mode/model/outputAvailability";
import {
  useLightingActions,
  useLightingControlState,
  type LightingControlState,
} from "@/features/mode/state/lightingControl";
import { MODE_GUARD_REASONS } from "@/features/mode/state/modeGuard";
import { ModeStrip } from "@/features/mode/ui/ModeStrip";
import { usePreference } from "@/features/persistence/preferences";
import { Scenes } from "@/features/scenes/ui/Scenes";
import {
  DEFAULT_SOLID_COLOR,
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  type LightingModeConfig,
  type LightingModeKind,
} from "@/shared/contracts/mode";
import { shallowEqual } from "@/shared/lib/store";
import { ModeStage } from "./ModeStage";
import { useLightsModel } from "./useLightsModel";
import styles from "./LightsCompact.module.css";

const selectCompactHue = (status: HueShellStatus) => ({
  hueConfigured: status.configured,
  hueReachable: status.reachable,
  // What the last bridge probe found; `null` while the first one is in flight.
  hueProbeVerdict: status.probeVerdict,
});

const selectCompactLighting = (state: LightingControlState) => ({
  lightingMode: state.lightingMode,
  outputTargets: state.outputTargets,
  localOutputConnected: state.localSink !== null,
  bootstrapDone: state.bootstrapDone,
  isModeTransitioning: state.isModeTransitioning,
  modeLockReason: state.modeLockReason,
});

/**
 * The tray-sized window: the modes, the scenes and the running mode's stage — the everyday
 * controls. The fine settings (saturation, black border, an effect's shape) and the outputs are on
 * Lights; the status bar says where the light goes.
 */
export const LightsCompact = memo(function LightsCompact() {
  const { hueConfigured, hueReachable, hueProbeVerdict } = useHueShellStatus(selectCompactHue, shallowEqual);
  const { lightingMode, outputTargets, localOutputConnected, bootstrapDone, isModeTransitioning, modeLockReason } =
    useLightingControlState(selectCompactLighting, shallowEqual);
  const { changeMode } = useLightingActions();
  const { brightnessLocked, brightnessTitle } = useLightsModel();
  const lastLit = usePreference("lastLitKind");

  // Without this gate the worker starts with nowhere to send frames. A bridge still being checked
  // blocks activation too, but is not reported as missing.
  const availability = outputAvailability({
    localOutputConnected,
    hueConfigured,
    hueReachable,
    hueProbeVerdict,
    bootstrapDone,
  });
  const calibrationLocked = modeLockReason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  // A choice in flight is not a lock: the strip and scenes ignore presses then, without dimming.
  const nonOffLocked = availability !== "ready" || calibrationLocked;
  const mode = normalizeLightingModeConfig(lightingMode);

  // Solid carries the saved targets; the other kinds apply to whatever is live.
  const pickMode = useCallback(
    (kind: LightingModeKind) => {
      const config = modeKind(kind).config({ solid: mode.solid ?? DEFAULT_SOLID_COLOR, ambilight: mode.ambilight ?? undefined });
      changeMode(kind === LIGHTING_MODE_KIND.SOLID ? { ...config, targets: outputTargets } : config);
    },
    [changeMode, mode.ambilight, mode.solid, outputTargets],
  );
  const change = useCallback(
    (next: LightingModeConfig) =>
      changeMode(next.kind === LIGHTING_MODE_KIND.SOLID ? { ...next, targets: outputTargets } : next),
    [changeMode, outputTargets],
  );

  return (
    <div className={styles.compact} data-testid="compact-layout">
      <ModeStrip
        variant="compact"
        value={mode.kind}
        isDisabled={(kind) => kind !== LIGHTING_MODE_KIND.OFF && nonOffLocked}
        busy={isModeTransitioning}
        lastLit={lastLit}
        onSelect={pickMode}
      />
      <Scenes mode={mode} disabled={nonOffLocked} busy={isModeTransitioning} onApply={change} />
      <ModeStage
        dense
        mode={mode}
        disabled={nonOffLocked}
        brightnessLocked={brightnessLocked}
        brightnessTitle={brightnessTitle}
        onModeChange={change}
        lastLit={lastLit}
        onTurnOn={nonOffLocked || isModeTransitioning ? undefined : () => change({ kind: lastLit })}
      />
    </div>
  );
});
