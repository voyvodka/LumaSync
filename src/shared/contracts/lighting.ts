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
 * preset maps to a **ceiling** on the EWMA (exponentially-weighted moving
 * average) coefficient `alpha` used as:
 *
 *   smoothed = alpha * newSample + (1 - alpha) * prevSmoothed
 *
 * The scene-adaptive stage in the Rust worker decides, per frame, how much
 * of that ceiling the content gets to use — a static scene sits well below
 * it, a hard change reaches it — and never exceeds it. The user's pick is a
 * lever on how much movement is allowed, not a fixed rate.
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

/** EWMA alpha ceiling for each {@link LightingSmoothingPreset}. */
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
 * Refusal codes from `apply_mode_change`. Invariant: on a gate, `mode` reports
 * the mode *actually running*, never an echo of the request, and the runtime is
 * untouched. Absent `targets` still means USB-required (legacy D-10).
 */
export const LIGHTING_MODE_GATE_STATUS = {
  DEVICE_NOT_CONNECTED: "DEVICE_NOT_CONNECTED",
  HUE_NOT_READY: "HUE_NOT_READY",
} as const;

export type LightingModeGateStatusCode =
  (typeof LIGHTING_MODE_GATE_STATUS)[keyof typeof LIGHTING_MODE_GATE_STATUS];

/**
 * Exhaustive `ModeCommandResult.status.code` set — `verify:shell-contracts` derives
 * the Rust `command_status(...)` literals and fails on an undeclared one. Preview
 * codes stay in `preview.ts` even though `lighting_mode.rs` emits them.
 */
export const LIGHTING_MODE_STATUS = {
  ...LIGHTING_MODE_GATE_STATUS,
  SOLID_MODE_APPLIED: "SOLID_MODE_APPLIED",
  SOLID_MODE_HUE_OUTPUT_SKIPPED: "SOLID_MODE_HUE_OUTPUT_SKIPPED",
  SOLID_MODE_APPLY_FAILED: "SOLID_MODE_APPLY_FAILED",
  AMBILIGHT_MODE_STARTED: "AMBILIGHT_MODE_STARTED",
  AMBILIGHT_MODE_UPDATED: "AMBILIGHT_MODE_UPDATED",
  AMBILIGHT_MODE_START_FAILED: "AMBILIGHT_MODE_START_FAILED",
  LIGHTING_MODE_STOPPED: "LIGHTING_MODE_STOPPED",
  LIGHTING_MODE_STATUS_OK: "LIGHTING_MODE_STATUS_OK",
} as const;

export type LightingModeStatusCode =
  (typeof LIGHTING_MODE_STATUS)[keyof typeof LIGHTING_MODE_STATUS];

/** Poisoned-mutex failures thrown by `set_lighting_mode` / `stop_lighting` /
 * `get_lighting_mode_status` / `start_led_test_pattern` as `Err("CODE: detail")`.
 * A thrown error, never a `status.code` — the command never got far enough. */
export const LIGHTING_COMMAND_ERRORS = {
  CONNECTION_STATE_LOCK_FAILED: "LIGHTING_CONNECTION_STATE_LOCK_FAILED",
  RUNTIME_STATE_LOCK_FAILED: "LIGHTING_RUNTIME_STATE_LOCK_FAILED",
} as const;

export type LightingCommandErrorCode =
  (typeof LIGHTING_COMMAND_ERRORS)[keyof typeof LIGHTING_COMMAND_ERRORS];

/**
 * True when the command was refused before touching any sink — so `mode` in
 * the same result is the running mode, not the requested one.
 */
export function isLightingModeGateCode(code: string): code is LightingModeGateStatusCode {
  return code === LIGHTING_MODE_GATE_STATUS.DEVICE_NOT_CONNECTED
    || code === LIGHTING_MODE_GATE_STATUS.HUE_NOT_READY;
}
