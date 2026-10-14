import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, check, readOrEmpty, stripComments } from "./lib.mjs";
import { source, deviceSource, rustHealthSource, wledRustSource } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Device contract
// ---------------------------------------------------------------------------

console.log("\n[ Device firmware profile ]");
const REQUIRED_FIRMWARE_PROFILE_VALUES = [
  "adalight",
  "lumasync-v1",
];
for (const value of REQUIRED_FIRMWARE_PROFILE_VALUES) {
  check(
    deviceSource.includes(`"${value}"`),
    `firmware profile value "${value}" defined`,
    `MISSING firmware profile value "${value}"`
  );
}
check(
  deviceSource.includes("FIRMWARE_PROFILE"),
  "FIRMWARE_PROFILE enum exported",
  "MISSING FIRMWARE_PROFILE enum"
);

console.log("\n[ Device color correction ]");
const REQUIRED_COLOR_CORRECTION_EXPORTS = [
  "ColorCorrectionConfig",
  "GAMMA_RANGE",
  "KELVIN_RANGE_K",
  "DEFAULT_COLOR_CORRECTION",
];
for (const name of REQUIRED_COLOR_CORRECTION_EXPORTS) {
  check(
    deviceSource.includes(name),
    `color correction export "${name}" present`,
    `MISSING color correction export "${name}"`
  );
}

console.log("\n[ Device LED chip type (v1.5 G3) ]");
const REQUIRED_LED_CHIP_TYPE_VALUES = [
  "ws2812b-grb",
  "sk6812-rgbw",
];
for (const value of REQUIRED_LED_CHIP_TYPE_VALUES) {
  check(
    deviceSource.includes(`"${value}"`),
    `LED chip type value "${value}" defined`,
    `MISSING LED chip type value "${value}"`
  );
}
check(
  deviceSource.includes("LED_CHIP_TYPE"),
  "LED_CHIP_TYPE enum exported",
  "MISSING LED_CHIP_TYPE enum"
);
check(
  deviceSource.includes("LedChipType"),
  "LedChipType type exported",
  "MISSING LedChipType type"
);

console.log("\n[ Device advertised firmware profile (v1.5 H4) ]");
check(
  deviceSource.includes("advertisedFirmwareProfile: FirmwareProfile | null"),
  "device.ts HealthCheckResult.advertisedFirmwareProfile field declared",
  "MISSING device.ts HealthCheckResult.advertisedFirmwareProfile field"
);
check(
  rustHealthSource.includes("pub advertised_firmware_profile: Option<FirmwareProfile>"),
  "Rust HealthCheckResult.advertised_firmware_profile field declared",
  "MISSING Rust HealthCheckResult.advertised_firmware_profile field"
);

// ---------------------------------------------------------------------------
// Device WLED status codes
// ---------------------------------------------------------------------------

console.log("\n[ WLED discovery wire shape — Vec<WledDeviceInfo> (A1.1) ]");
check(
  wledRustSource.includes("pub devices: Vec<WledDeviceInfo>"),
  "WledDiscoveryResponse.devices is Vec<WledDeviceInfo> (not Option)",
  "MISSING: WledDiscoveryResponse.devices should be Vec<WledDeviceInfo>"
);
check(
  !wledRustSource.includes("pub device: Option<WledDeviceInfo>"),
  "Old WledDiscoveryResponse.device: Option<> removed",
  "STILL PRESENT: old WledDiscoveryResponse.device: Option<> — A1.1 migration incomplete"
);
check(
  deviceSource.includes("devices: WledDeviceInfo[]"),
  "TS WledDiscoveryResponse.devices is WledDeviceInfo[] (device.ts)",
  "MISSING: TS WledDiscoveryResponse.devices array field"
);

console.log("\n[ WLED connect request shape — device wrapper (A1.5) ]");
check(
  wledRustSource.includes("pub device: WledDeviceInfo"),
  "WledConnectRequest.device: WledDeviceInfo present in Rust",
  "MISSING: WledConnectRequest.device field — A1.5 connect fix incomplete"
);
check(
  wledRustSource.includes("pub struct WledTestRequest") &&
    wledRustSource.includes("pub device: WledDeviceInfo"),
  "WledTestRequest.device: WledDeviceInfo present in Rust",
  "MISSING: WledTestRequest.device field — A1.6 test fix incomplete"
);

console.log("\n[ WLED test response — sendLatencyMs (A1.6) ]");
check(
  wledRustSource.includes("pub send_latency_ms: Option<u64>"),
  "WledTestResponse.send_latency_ms: Option<u64> present in Rust",
  "MISSING: WledTestResponse.send_latency_ms field — A1.6 test response fix incomplete"
);
// The old name claimed a round trip UDP cannot provide. Pinning its absence
// stops it coming back with the same misleading meaning.
check(
  !wledRustSource.includes("round_trip_ms"),
  "Old WledTestResponse.round_trip_ms name is gone",
  "STILL PRESENT: round_trip_ms — UDP has no ACK, so the name overclaims"
);
check(
  !wledRustSource.match(/pub struct WledTestResponse[^}]*pub device:/s),
  "Old WledTestResponse.device field removed (A1.6)",
  "STILL PRESENT: WledTestResponse.device field — A1.6 cleanup incomplete"
);

// ---------------------------------------------------------------------------
// LED colour order — derived Rust ↔ device.ts parity. Unlike the chip-type
// block above (presence only), the values are read from both sides: a variant
// added in Rust without its TS twin would deserialise from nothing the UI can
// send, and one added only in TS would be a serde rejection at the IPC boundary.
// ---------------------------------------------------------------------------
console.log("\n[ LED colour order — Rust ↔ device.ts parity ]");
const rustLedOutputSource = readOrEmpty(
  resolve(ROOT, "src-tauri/src/commands/led_output/wire.rs"),
  "rust led_output wire"
);
const rustColorOrderBlock = rustLedOutputSource.match(
  /pub enum LedColorOrder\s*\{([\s\S]*?)\n\}/
);
const rustColorOrders = rustColorOrderBlock
  ? [...rustColorOrderBlock[1].matchAll(/^\s*([A-Z][A-Za-z]*),/gm)].map((m) => m[1].toLowerCase())
  : [];
const tsColorOrderBlock = deviceSource.match(/LED_COLOR_ORDER\s*=\s*\{([\s\S]*?)\}\s*as const/);
const tsColorOrders = tsColorOrderBlock
  ? [...tsColorOrderBlock[1].matchAll(/:\s*"([a-z]+)"/g)].map((m) => m[1])
  : [];
check(
  rustColorOrders.length > 0 && tsColorOrders.length > 0,
  `extracted ${rustColorOrders.length} Rust / ${tsColorOrders.length} TS colour orders`,
  "EXTRACTION FAILED: could not read Rust LedColorOrder or TS LED_COLOR_ORDER"
);
check(
  rustColorOrders.join(",") === tsColorOrders.join(","),
  `LED_COLOR_ORDER matches Rust LedColorOrder in order (${tsColorOrders.join(" ")})`,
  `COLOUR ORDER DRIFT:\n     Rust: ${rustColorOrders.join(" ")}\n     TS  : ${tsColorOrders.join(" ")}`
);
// The backend hydrates the order from the persisted state, so the key it reads
// and the key the frontend writes must be the same string.
const rustShellStateSource = readOrEmpty(
  resolve(ROOT, "src-tauri/src/commands/shell_state.rs"),
  "rust shell_state"
);
const rustShellStateProduction = rustShellStateSource.split(/\nmod tests\s*\{/)[0];
// `led_strips.rs` reads `ledStrips`, and the frozen v7 keys for a file not yet migrated.
const rustStripsProduction = readOrEmpty(
  resolve(ROOT, "src-tauri/src/models/led_strips.rs"),
  "rust led_strips"
).split(/\nmod tests\s*\{/)[0];
const stripsContractSource = readOrEmpty(resolve(ROOT, "src/shared/contracts/strips.ts"), "strips contract");
const legacyStripKeysBlock = stripsContractSource.match(/export interface LegacyV7StripKeys \{([\s\S]*?)\n\}/);
const legacyStripKeys = new Set(
  legacyStripKeysBlock ? [...legacyStripKeysBlock[1].matchAll(/^\s{2}([a-zA-Z]\w*)\??:/gm)].map((m) => m[1]) : []
);
check(
  ["lastSuccessfulPort", "lastWledSink", "ledCalibration", "firmwareProfile", "selectedChipType", "ledColorOrder"].every(
    (key) => legacyStripKeys.has(key)
  ),
  "LegacyV7StripKeys declares the six frozen single-output keys",
  "LEGACY KEY DRIFT: LegacyV7StripKeys is missing one of the six keys a v7 file stores"
);
check(
  source.includes("ledStrips?: LedStrip[]") && rustStripsProduction.includes('present(state, "ledStrips")'),
  "ShellState.ledStrips is the key led_strips.rs reads strips from",
  'PERSISTED KEY DRIFT: ShellState.ledStrips and led_strips.rs present(state, "ledStrips") disagree'
);
// Only the derivation and the migration may see the frozen keys; anything else
// reading them would bypass the stored strips.
{
  const allowed = new Set(["src/features/strips/model/legacyStrips.ts", "src/features/persistence/migrations.ts"]);
  const offenders = [];
  const visit = (dir) => {
    for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") visit(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !allowed.has(rel) && rel !== "src/shared/contracts/strips.ts") {
        if (/import[^;]*\bLegacyV7StripKeys\b[^;]*;/.test(readFileSync(resolve(ROOT, rel), "utf8"))) offenders.push(rel);
      }
    }
  };
  visit("src");
  visit("mock");
  check(
    offenders.length === 0,
    "LegacyV7StripKeys is imported only by legacyStrips.ts and migrations.ts",
    `LEGACY KEY LEAK: ${offenders.join(", ")} import LegacyV7StripKeys — read strips through stripSelectors`
  );
}

// Every key a Rust typed read names must be a ShellState field: a misspelt key
// reads as "never saved", and every hydration fallback built on it goes quiet.
console.log("\n[ Persisted keys — shell_state.rs / led_strips.rs typed reads ↔ ShellState ]");
{
  const shellStateInterface = source.match(/export interface ShellState \{([\s\S]*?)\n\}/);
  const fields = new Set(
    shellStateInterface
      ? [...shellStateInterface[1].matchAll(/^\s{2}([a-zA-Z]\w*)\??:/gm)].map((m) => m[1])
      : []
  );
  // The frozen v7 keys are fine only where the legacy derivation reads them; a
  // typed read of one anywhere else would bypass the stored strips.
  const stripReadFields = new Set([...fields, ...legacyStripKeys]);
  const readKeys = [
    ...[...rustShellStateProduction.matchAll(/self\.(?:read|0\.get)\("([a-zA-Z]\w*)"\)/g)].map((m) => [m[1], fields]),
    ...[...rustStripsProduction.matchAll(/present\(state, "([a-zA-Z]\w*)"\)/g)].map((m) => [m[1], stripReadFields]),
  ];
  check(
    fields.size > 0 && readKeys.length > 0,
    `extracted ${fields.size} ShellState fields and ${readKeys.length} Rust-read keys`,
    "EXTRACTION FAILED: could not read ShellState fields or shell_state.rs typed reads"
  );
  for (const [key, allowed] of readKeys) {
    check(
      allowed.has(key),
      `Rust reads "${key}", a key it may read there`,
      allowed === fields && legacyStripKeys.has(key)
        ? `PERSISTED KEY DRIFT: shell_state.rs reads the frozen "${key}" — read it through the strips`
        : `PERSISTED KEY DRIFT: Rust reads "${key}", which ShellState does not declare`
    );
  }
}

// ---------------------------------------------------------------------------
// USB VID/PID allowlist parity. `SUPPORTED_CONTROLLER_IDS` already mirrors the
// Rust allowlist with no consumer and nothing asserting agreement until now.
// ---------------------------------------------------------------------------
console.log("\n[ USB VID/PID allowlist — Rust ↔ device.ts parity ]");
const rustAllowlistBlock = rustHealthSource.match(
  /SUPPORTED_USB_DEVICE_ALLOWLIST[^=]*=\s*&\[([\s\S]*?)\n\];/
);
const tsAllowlistBlock = deviceSource.match(
  /SUPPORTED_CONTROLLER_IDS\s*=\s*\[([\s\S]*?)\n\]/
);
const rustVidPids = rustAllowlistBlock
  ? [...rustAllowlistBlock[1].matchAll(/\(\s*0x([0-9A-Fa-f]{4})\s*,\s*0x([0-9A-Fa-f]{4})\s*\)/g)]
      .map((m) => `${m[1]}:${m[2]}`.toUpperCase())
  : [];
const tsVidPids = tsAllowlistBlock
  ? [...tsAllowlistBlock[1].matchAll(/"([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})"/g)]
      .map((m) => `${m[1]}:${m[2]}`.toUpperCase())
  : [];
check(
  rustVidPids.length > 0 && tsVidPids.length > 0,
  `extracted ${rustVidPids.length} Rust / ${tsVidPids.length} TS allowlist entries`,
  "EXTRACTION FAILED: could not read one or both VID/PID allowlists"
);
check(
  rustVidPids.length === tsVidPids.length,
  `allowlist length matches (${rustVidPids.length} entries)`,
  `ALLOWLIST LENGTH DRIFT: Rust has ${rustVidPids.length}, device.ts has ${tsVidPids.length}`
);
check(
  rustVidPids.join(",") === tsVidPids.join(","),
  "allowlist entries match Rust SUPPORTED_USB_DEVICE_ALLOWLIST in order",
  `ALLOWLIST DRIFT:\n     Rust: ${rustVidPids.join(" ")}\n     TS  : ${tsVidPids.join(" ")}`
);

// ---------------------------------------------------------------------------
// Serial port codes — derived Rust → device.ts parity
// ---------------------------------------------------------------------------
console.log("\n[ Serial port codes — Rust → device.ts parity ]");
const rustPortCodes = [
  ...new Set(
    [...stripComments(rustHealthSource).matchAll(/"([A-Z][A-Z0-9_]*(?:PORT|PORTS)[A-Z0-9_]*)"/g)]
      .map((m) => m[1])
  ),
].sort();
const EXPECTED_PORT_CODE_COUNT = 4;
check(
  rustPortCodes.length === EXPECTED_PORT_CODE_COUNT,
  `harvested exactly ${EXPECTED_PORT_CODE_COUNT} PORT codes from device_connection.rs`,
  `HARVEST COUNT DRIFT: expected ${EXPECTED_PORT_CODE_COUNT} PORT codes, got `
    + `${rustPortCodes.length} [${rustPortCodes.join(", ")}] — update the pin deliberately`
);
for (const code of rustPortCodes) {
  check(
    deviceSource.includes(`"${code}"`),
    `port code "${code}" declared in device.ts`,
    `UNDECLARED port code "${code}" — device_connection.rs emits it but device.ts `
      + `does not declare it (this is how "UNSUPPORTED_PORT" survived transposed)`
  );
}

// `HANDSHAKE` has no underscore, so `harvestCodes` skips it by design. Without
// this pin the step would silently leave the contract and nothing would notice.
console.log("\n[ Serial health-check steps — Rust → device.ts parity ]");
const rustHealthSteps = [
  ...new Set(
    [...stripComments(rustHealthSource).matchAll(/step:\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1])
  ),
].sort();
const EXPECTED_HEALTH_STEP_COUNT = 5;
check(
  rustHealthSteps.length === EXPECTED_HEALTH_STEP_COUNT,
  `harvested exactly ${EXPECTED_HEALTH_STEP_COUNT} health steps from device_connection.rs`,
  `HARVEST COUNT DRIFT: expected ${EXPECTED_HEALTH_STEP_COUNT} steps, got `
    + `${rustHealthSteps.length} [${rustHealthSteps.join(", ")}] — update the pin deliberately`
);
for (const step of rustHealthSteps) {
  check(
    deviceSource.includes(`${step}: "${step}"`),
    `health step "${step}" declared in device.ts > DEVICE_HEALTH_STEPS`,
    `UNDECLARED health step "${step}" — device_connection.rs reports it on `
      + `HealthStepResult.step but DEVICE_HEALTH_STEPS does not declare it`
  );
}

