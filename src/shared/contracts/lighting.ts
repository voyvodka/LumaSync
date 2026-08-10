/**
 * Lighting smoothing contracts (v1.4 unification).
 *
 * The preset that governs how aggressively both the USB strip and the Hue
 * branch of the ambilight pump follow per-frame color changes. Replaces the
 * earlier `HueIntensityPreset` (Hue-only) + continuous `smoothingAlpha`
 * slider pair with a single user-facing control that drives both sinks.
 *
 * Rust handoff: `LightingSmoothingPreset` in
 * `src-tauri/src/commands/hue_intensity.rs`. Coefficients below mirror the
 * Rust `coefficient()` implementation — keep the two in sync.
 *
 * Backward compatibility:
 *   - `HueIntensityPreset` remains a deprecated alias for
 *     `LightingSmoothingPreset` so pre-v1.4 call sites keep compiling until
 *     the v1.5 clean-up removes them.
 *   - `HUE_INTENSITY_PRESET_COEFFICIENTS` / `DEFAULT_HUE_INTENSITY_PRESET`
 *     also re-exported from `./hue.ts` via identical deprecated aliases.
 */

/**
 * User-facing smoothing presets applied to every ambilight sink. Each
 * preset maps to a single EWMA (exponentially-weighted moving average)
 * coefficient `alpha` used as:
 *
 *   smoothed = alpha * newSample + (1 - alpha) * prevSmoothed
 *
 * Lower alpha ⇒ heavier smoothing ⇒ calmer lights. Higher alpha ⇒
 * snappier response ⇒ more intense.
 *
 * - `subtle` (0.15): slow, relaxed — ideal for bedroom / background.
 * - `moderate` (0.35): balanced — default for living rooms.
 * - `intense` (0.60): fast-reacting — gaming / action content.
 *
 * Stored under `ShellState.lightingIntensityPreset`. Streamed to the Rust
 * worker via `AmbilightPayload.lightingSmoothingPreset`.
 */
export type LightingSmoothingPreset = "subtle" | "moderate" | "intense";

export const LIGHTING_SMOOTHING_PRESET_COEFFICIENTS: Readonly<
  Record<LightingSmoothingPreset, number>
> = {
  subtle: 0.15,
  moderate: 0.35,
  intense: 0.6,
};

/** Default preset applied when `ShellState.lightingIntensityPreset` is absent. */
export const DEFAULT_LIGHTING_SMOOTHING_PRESET: LightingSmoothingPreset = "moderate";

// ---------------------------------------------------------------------------
// Lighting-mode command status codes
// ---------------------------------------------------------------------------

/**
 * `set_lighting_mode` codes the frontend discriminates on. `..._HUE_OUTPUT_SKIPPED`
 * replaces the old `SOLID_MODE_APPLIED` lie when the Hue leg sent nothing.
 */
export const LIGHTING_MODE_STATUS = {
  SOLID_MODE_APPLIED: "SOLID_MODE_APPLIED",
  SOLID_MODE_HUE_OUTPUT_SKIPPED: "SOLID_MODE_HUE_OUTPUT_SKIPPED",
  SOLID_MODE_APPLY_FAILED: "SOLID_MODE_APPLY_FAILED",
} as const;

export type LightingModeStatusCode =
  (typeof LIGHTING_MODE_STATUS)[keyof typeof LIGHTING_MODE_STATUS];
