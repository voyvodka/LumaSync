import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, check, readOrEmpty, stripComments, constMembers, checkWireUnion } from "./lib.mjs";
import { lightingSource, rustLightingSource } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Lighting-mode status codes — derived Rust → TS parity. Only literal first
// args count; the preview call sites pass a constant and belong to preview.ts.
// ---------------------------------------------------------------------------

console.log("\n[ Lighting-mode status codes — Rust → lighting.ts parity ]");
const rustLightingProduction = rustLightingSource.split(/\nmod tests\s*\{/)[0];
const emittedLightingCodes = [
  ...new Set(
    [...rustLightingProduction.matchAll(/command_status\(\s*"([A-Z][A-Z0-9_]*)"/g)]
      .map((m) => m[1])
  ),
].sort();
// Pinned, not `> 0`: the harvest sees string literals only, so hoisting a code
// to a `const` (the shape led_preview.rs already uses) would silently drop it while
// the other nine still matched. Bump this deliberately when a code is added.
// 10 → 11: LIGHTING_MODE_SHUTTING_DOWN, a start refused once the quit began.
// 12 → 11: LIGHTING_MODE_STATUS_OK went with `get_lighting_mode_status`.
// 11 → 14: EFFECT_MODE_STARTED / _UPDATED / _START_FAILED, the Effect mode's own codes.
const EXPECTED_LIGHTING_CODE_COUNT = 14;
check(
  emittedLightingCodes.length === EXPECTED_LIGHTING_CODE_COUNT,
  `harvested exactly ${EXPECTED_LIGHTING_CODE_COUNT} command_status codes from lighting_mode/transition.rs`,
  `HARVEST COUNT DRIFT: expected ${EXPECTED_LIGHTING_CODE_COUNT} lighting codes, got `
    + `${emittedLightingCodes.length} [${emittedLightingCodes.join(", ")}] — a code was added, `
    + `removed, or refactored from a string literal into a constant (which this harvest cannot see)`
);
for (const code of emittedLightingCodes) {
  check(
    lightingSource.includes(`"${code}"`),
    `lighting status code "${code}" declared in lighting.ts`,
    `UNDECLARED lighting status code "${code}" — Rust emits it but `
      + `lighting.ts > LIGHTING_MODE_STATUS does not declare it`
  );
}

// The two gate codes carry an extra behavioural contract (`mode` reports the
// running mode, not the requested one), so they must stay separately addressable.
check(
  lightingSource.includes("LIGHTING_MODE_GATE_STATUS")
    && lightingSource.includes("isLightingModeGateCode"),
  "LIGHTING_MODE_GATE_STATUS + isLightingModeGateCode exported",
  "MISSING LIGHTING_MODE_GATE_STATUS / isLightingModeGateCode in lighting.ts"
);

// ---------------------------------------------------------------------------
// The lighting transaction — its two status shapes pinned to their one
// constructor each, and its wire enums held equal to the contract's values.
// ---------------------------------------------------------------------------
console.log("\n[ Lighting transaction — Rust → lightingRuntime.ts parity ]");
{
  const lightingRuntimeSource = readOrEmpty(
    resolve(ROOT, "src/shared/contracts/lightingRuntime.ts"),
    "lightingRuntime"
  );
  // The transaction is a module directory: every file of it, `mod.rs` first.
  const outputsDir = resolve(ROOT, "src-tauri/src/commands/lighting_mode/outputs");
  const rustOutputs = stripComments(
    ["mod.rs", ...readdirSync(outputsDir).filter((f) => f.endsWith(".rs") && f !== "mod.rs").sort()]
      .map((f) => readOrEmpty(resolve(outputsDir, f), `rust outputs/${f}`))
      .join("\n")
  );
  const rustTuning = stripComments(
    readOrEmpty(resolve(ROOT, "src-tauri/src/commands/lighting_mode/tuning.rs"), "rust tuning")
  );
  const rustSnapshot = stripComments(
    readOrEmpty(resolve(ROOT, "src-tauri/src/commands/lighting_mode/snapshot.rs"), "rust snapshot")
  );
  const rustHueHealth = stripComments(
    readOrEmpty(resolve(ROOT, "src-tauri/src/commands/hue/health.rs"), "rust hue health")
  );
  const hueHealthSource = readOrEmpty(
    resolve(ROOT, "src/shared/contracts/hueHealth.ts"),
    "hueHealth"
  );
  const rustModeConfig = stripComments(
    readOrEmpty(resolve(ROOT, "src-tauri/src/commands/lighting_mode/config.rs"), "rust mode config")
  );
  const effectsSource = readOrEmpty(resolve(ROOT, "src/shared/contracts/effects.ts"), "effects");
  const literalCodes = (source, fn) =>
    [...source.matchAll(new RegExp(`${fn}\\(\\s*"([A-Z][A-Z0-9_]*)"`, "g"))].map((m) => m[1]);
  checkWireUnion(
    "LightingOutputsStatusCode",
    literalCodes(rustOutputs, "outputs_status"),
    constMembers(lightingRuntimeSource, "LIGHTING_OUTPUTS_STATUS"),
    8
  );
  checkWireUnion(
    "LightingRetuneStatusCode",
    literalCodes(rustTuning, "retune_status"),
    constMembers(lightingRuntimeSource, "LIGHTING_RETUNE_STATUS"),
    3
  );

  // `#[serde(rename_all = "camelCase")]` unit variants, as the wire spells them.
  const rustEnumValues = (source, name) => {
    const block = source.match(new RegExp(`pub enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    return block
      ? [...block[1].matchAll(/^\s*([A-Z][A-Za-z]*),/gm)].map(
          (m) => m[1][0].toLowerCase() + m[1].slice(1)
        )
      : [];
  };
  const tsValues = (source, name) => {
    const block = source.match(new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\} as const;`));
    return block ? [...block[1].matchAll(/:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]) : [];
  };
  for (const [rustSource, rustName, tsSource, tsName] of [
    [rustSnapshot, "HueLeftOutReason", lightingSource, "HUE_LEFT_OUT_REASON"],
    [rustSnapshot, "LightingPhase", lightingRuntimeSource, "LIGHTING_RUNTIME_PHASE"],
    [rustSnapshot, "BootHueRetryState", lightingRuntimeSource, "BOOT_HUE_RETRY_STATE"],
    [rustOutputs, "LightingOrigin", lightingRuntimeSource, "LIGHTING_ORIGIN"],
    [rustHueHealth, "HueBridgeVerdict", hueHealthSource, "HUE_BRIDGE_VERDICT"],
    [rustModeConfig, "EffectId", effectsSource, "EFFECT_IDS"],
    [rustModeConfig, "PaletteId", effectsSource, "PALETTE_IDS"],
    [rustModeConfig, "EffectDirection", effectsSource, "EFFECT_DIRECTIONS"],
  ]) {
    const rust = rustEnumValues(rustSource, rustName);
    const ts = tsValues(tsSource, tsName);
    check(
      rust.length > 0 && rust.join(",") === ts.join(","),
      `${tsName} matches Rust ${rustName} (${ts.join(" ")})`,
      `WIRE ENUM DRIFT: ${rustName} [${rust.join(" ")}] vs ${tsName} [${ts.join(" ")}]`
    );
  }
}
