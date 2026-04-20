/**
 * useAccentTheme — apply the active lighting accent to CSS custom properties.
 *
 * Writes `--accent-color`, `--accent-color-soft`, and `--accent-gradient` on
 * the document root every time the resolved accent changes. Consumers read
 * those variables via Tailwind arbitrary values
 * (e.g. `bg-[var(--accent-color)]`) so the UI retints in a single frame
 * without prop drilling.
 *
 * Solid-mode override:
 *   The component that uses the compact SolidColorPanel keeps a local draft
 *   of the RGB selection while the slider/picker is being dragged. That draft
 *   only commits to the parent `lightingMode` on debounce intervals, so if we
 *   derived the accent from `lightingMode` alone the UI would lag the slider.
 *   Passing `solidOverride` lets the caller feed the live draft and keep the
 *   retint perfectly synchronous with the input.
 */

import { useEffect, useMemo } from "react";
import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../mode/model/contracts";
import {
  AMBILIGHT_ACCENT,
  OFF_ACCENT,
  solidAccent,
  type AccentTheme,
} from "../../shared/theme/accent";

interface SolidOverride {
  r: number;
  g: number;
  b: number;
}

export function resolveAccent(
  lightingMode: LightingModeConfig,
  solidOverride?: SolidOverride,
): AccentTheme {
  if (lightingMode.kind === LIGHTING_MODE_KIND.OFF) return OFF_ACCENT;
  if (lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) return AMBILIGHT_ACCENT;

  // SOLID — prefer the caller-supplied draft override so slider drags retint
  // the UI live. Fall back to the committed lighting mode payload.
  const source = solidOverride ?? lightingMode.solid;
  if (!source) return OFF_ACCENT;
  return solidAccent(source.r, source.g, source.b);
}

export function useAccentTheme(
  lightingMode: LightingModeConfig,
  solidOverride?: SolidOverride,
): AccentTheme {
  const theme = useMemo(
    () => resolveAccent(lightingMode, solidOverride),
    [lightingMode, solidOverride?.r, solidOverride?.g, solidOverride?.b],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent-color", theme.color);
    root.style.setProperty("--accent-color-soft", theme.colorSoft);
    // `none` keeps the custom property valid while signalling "no gradient"
    // to consumers that read it as a background value.
    root.style.setProperty("--accent-gradient", theme.gradient ?? "none");
  }, [theme]);

  return theme;
}
