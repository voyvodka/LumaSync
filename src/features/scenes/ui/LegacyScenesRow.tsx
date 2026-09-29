import { useTranslation } from "react-i18next";

import { SCENE_PRESETS, findMatchingScenePreset } from "@/features/mode/model/scenePresets";
import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/shared/contracts/mode";
import { ScenesRow } from "./ScenesRow";

/** The five fixed colours, on the scenes row until the scenes model replaces them. */
export function LegacyScenesRow({
  mode,
  disabled,
  onModeChange,
  dense = false,
}: {
  mode: LightingModeConfig;
  disabled: boolean;
  dense?: boolean;
  onModeChange: (next: LightingModeConfig) => void;
}) {
  const { t } = useTranslation();
  const active = mode.kind === LIGHTING_MODE_KIND.SOLID && mode.solid ? findMatchingScenePreset(mode.solid) : undefined;
  return (
    <ScenesRow
      dense={dense}
      disabled={disabled}
      scenes={SCENE_PRESETS.map((preset) => ({
        id: preset.id,
        name: t(preset.labelKey),
        swatch: preset.gradient,
        active: active?.id === preset.id,
      }))}
      onPick={(id) => {
        const preset = SCENE_PRESETS.find((p) => p.id === id);
        if (!preset) return;
        onModeChange({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: { r: preset.r, g: preset.g, b: preset.b, brightness: preset.brightness },
        });
      }}
    />
  );
}
