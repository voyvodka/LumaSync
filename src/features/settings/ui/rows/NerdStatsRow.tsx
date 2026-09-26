import { usePreference } from "@/features/persistence/preferences";
import { TelemetrySection } from "@/features/telemetry/ui/TelemetrySection";
import type { SettingsEnv } from "../settingsEnv";
import { PreferenceSwitch } from "./PreferenceSwitch";

/** The switch, and the readout it opens: nothing polls telemetry while it is closed. */
export function NerdStatsRow({ localOutputConnected, hueActive = false }: SettingsEnv) {
  const on = usePreference("showNerdStats");
  return (
    <>
      <PreferenceSwitch
        pref="showNerdStats"
        on={true}
        off={false}
        labelKey="settings:nerdStats.label"
        hintKey="settings:nerdStats.description"
        testId="nerd-stats-toggle"
      />
      <TelemetrySection open={on} localOutputConnected={localOutputConnected} hueActive={hueActive} />
    </>
  );
}
