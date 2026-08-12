#!/usr/bin/env node
/**
 * Phase 01 Shell Contracts Verifier
 *
 * Fails (exit 1) if required exports, section IDs, error codes, or
 * command strings drift across `src/shared/contracts/*.ts`.
 *
 * Green means DECLARED, not sound: no grep can tell you a code sits in the right
 * union, is wired to a result type, or is handled by any consumer.
 *
 * The check count is not a coverage score: derived Rust parity covers one emit
 * surface of roughly seven, and the PORT block four codes of one file.
 *
 * Usage: node scripts/verify/phase01-shell-contracts.mjs
 */

import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/shell.ts");

// ---------------------------------------------------------------------------
// Required exports
// ---------------------------------------------------------------------------
const REQUIRED_EXPORTS = [
  "TRAY_MENU_IDS",
  "TrayMenuId",
  "SECTION_IDS",
  "SectionId",
  "SECTION_ORDER",
  "ShellState",
  "SHELL_STATE_SCHEMA_VERSION",
  "DEFAULT_SHELL_STATE",
  "SHELL_STORE_KEY",
  "UI_MODE_SIZES",
  "UI_MODE_MIN_SIZES",
];

// ---------------------------------------------------------------------------
// Required tray menu ID values
// ---------------------------------------------------------------------------
const REQUIRED_TRAY_IDS = [
  "open-settings",
  "status-indicator",
  "tray-lights-off",
  "tray-resume-last-mode",
  "tray-solid-color",
  "quit",
];

// ---------------------------------------------------------------------------
// Required sidebar section ID values (main nav)
// ---------------------------------------------------------------------------
const REQUIRED_SECTION_IDS = [
  "lights",
  "led-setup",
  "devices",
  "system",
  "room-map",
];

// ---------------------------------------------------------------------------
// Required ShellState fields
// ---------------------------------------------------------------------------
const REQUIRED_STATE_FIELDS = [
  "schemaVersion",
  // v1.5 (post-W4-F2) — corner+size geometry replaced by mode-invariant center.
  // Bumped `SHELL_STATE_SCHEMA_VERSION` to 3; the 2 → 3 migration shim in
  // `features/persistence/migrations.ts` derives the center from legacy fields
  // and strips them.
  "windowCenterX",
  "windowCenterY",
  "lastSection",
  "trayHintShown",
  "startupEnabled",
  "roomMap",
  "roomMapVersion",
];

/**
 * v1.4 Wave 1 ShellState additions. All optional / additive — strict
 * presence check but no default-value check because each has its own
 * backend-provided default.
 */
const REQUIRED_V14_STATE_FIELDS = [
  "lightingIntensityPreset",
  "colorCorrection",
  "firmwareProfile",
  "selectedDisplayId",
  "notificationsEnabled",
];

/**
 * v1.5 ShellState additions. All optional / additive — the absence of
 * each field naturally degrades to a v1.4-compatible default
 * (`hasCompletedOnboarding=false` shows onboarding once, `updateChannel`
 * absent ⇒ stable channel, `selectedChipType` absent ⇒ WS2812B GRB).
 * Strict optional-`?:` presence check, no default-value check.
 */
const REQUIRED_V15_STATE_FIELDS = [
  "hasCompletedOnboarding",
  "updateChannel",
  "selectedChipType",
  "dontWarnFirmwareProfileMismatch",
];

/** v1.5 contract surface that must be exported alongside the new fields. */
const REQUIRED_V15_EXPORTS = [
  "UpdateChannel",
  "DEFAULT_UPDATE_CHANNEL",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let errors = 0;
let checks = 0;

function pass(msg) {
  checks++;
  console.log(`  ✔  ${msg}`);
}

function fail(msg) {
  errors++;
  checks++;
  console.error(`  ✘  ${msg}`);
}

/**
 * Informational, non-asserting log line. Unlike pass()/fail() it does NOT
 * touch the `checks`/`errors` counters, so it can surface a "known-pending"
 * fact (e.g. a Phase 0 command whose Rust handler lands in Phase 1) without
 * coloring the run pass or fail.
 */
function note(msg) {
  console.log(`  \u2022  ${msg}`);
}

function check(condition, passMsg, failMsg) {
  if (condition) {
    pass(passMsg);
  } else {
    fail(failMsg);
  }
}

function readOrEmpty(path, label) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    console.error(`\nWARN: Cannot read ${label} contract file: ${path}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("\nPhase 01 — Shell Contracts Verifier");
console.log("====================================");

// Read contract file
let source;
try {
  source = readFileSync(CONTRACT_FILE, "utf-8");
  console.log(`\nFile: ${CONTRACT_FILE}`);
} catch (err) {
  console.error(`\nFATAL: Cannot read contract file: ${CONTRACT_FILE}`);
  console.error(err.message);
  process.exit(1);
}

// Check required exports
console.log("\n[ Required exports ]");
for (const name of REQUIRED_EXPORTS) {
  check(
    source.includes(`export`) && source.includes(name),
    `export "${name}" present`,
    `MISSING export "${name}"`
  );
}

// Check tray menu IDs
console.log("\n[ Tray menu IDs ]");
for (const id of REQUIRED_TRAY_IDS) {
  check(
    source.includes(`"${id}"`),
    `tray id "${id}" defined`,
    `MISSING tray id "${id}"`
  );
}

// Check section IDs
console.log("\n[ Sidebar section IDs ]");
for (const id of REQUIRED_SECTION_IDS) {
  check(
    source.includes(`"${id}"`),
    `section id "${id}" defined`,
    `MISSING section id "${id}"`
  );
}

// Check ShellState fields
console.log("\n[ ShellState fields ]");
for (const field of REQUIRED_STATE_FIELDS) {
  check(
    source.includes(field + ":") || source.includes(field + "?:"),
    `ShellState field "${field}" defined`,
    `MISSING ShellState field "${field}"`
  );
}

// Check v1.4 optional additions
console.log("\n[ ShellState v1.4 additions ]");
for (const field of REQUIRED_V14_STATE_FIELDS) {
  check(
    source.includes(field + "?:"),
    `ShellState v1.4 field "${field}" declared optional`,
    `MISSING optional ShellState v1.4 field "${field}"`
  );
}

// Check v1.5 optional additions (chip type, update channel, onboarding)
console.log("\n[ ShellState v1.5 additions ]");
for (const field of REQUIRED_V15_STATE_FIELDS) {
  check(
    source.includes(field + "?:"),
    `ShellState v1.5 field "${field}" declared optional`,
    `MISSING optional ShellState v1.5 field "${field}"`
  );
}
for (const name of REQUIRED_V15_EXPORTS) {
  check(
    source.includes(name),
    `v1.5 export "${name}" present`,
    `MISSING v1.5 export "${name}"`
  );
}


// Check SECTION_ORDER completeness
console.log("\n[ SECTION_ORDER completeness ]");
const orderMatch = source.match(/SECTION_ORDER[^=]*=\s*\[([^\]]+)\]/s);
if (orderMatch) {
  const orderBlock = orderMatch[1];
  const ID_TO_CONST = {
    "lights": "LIGHTS",
    "led-setup": "LED_SETUP",
    "devices": "DEVICES",
    "system": "SYSTEM",
    "room-map": "ROOM_MAP",
  };
  for (const id of REQUIRED_SECTION_IDS) {
    const constName = ID_TO_CONST[id] || id.toUpperCase();
    check(
      orderBlock.includes(`SECTION_IDS.${constName}`),
      `"${id}" present in SECTION_ORDER`,
      `MISSING "${id}" from SECTION_ORDER`
    );
  }
} else {
  check(
    source.includes("SECTION_ORDER"),
    "SECTION_ORDER exported",
    "SECTION_ORDER array not found"
  );
}

// ---------------------------------------------------------------------------
// Schema version bump — gates the newest migration step; earlier steps chain.
// ---------------------------------------------------------------------------
console.log("\n[ Shell state schema version (v1.6 stranded-zone recovery) ]");
check(
  /SHELL_STATE_SCHEMA_VERSION\s*=\s*4\b/.test(source),
  "SHELL_STATE_SCHEMA_VERSION === 4 (stranded Hue zone recovery gate)",
  "SHELL_STATE_SCHEMA_VERSION not bumped to 4 — the 3 → 4 recovery shim has no trigger"
);

// ---------------------------------------------------------------------------
// Hue contract
// ---------------------------------------------------------------------------
const HUE_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/hue.ts");
const hueSource = readOrEmpty(HUE_CONTRACT_FILE, "hue");

console.log("\n[ Hue channel position commands ]");
const REQUIRED_HUE_CHANNEL_COMMANDS = [
  "update_hue_channel_positions",
];
for (const cmd of REQUIRED_HUE_CHANNEL_COMMANDS) {
  check(
    hueSource.includes(`"${cmd}"`),
    `hue command "${cmd}" defined`,
    `MISSING hue command "${cmd}" in hue.ts`
  );
}

const REQUIRED_HUE_CHANNEL_STATUS = [
  "HUE_CHANNEL_POSITIONS_UPDATED",
  "HUE_CHANNEL_POSITIONS_FAILED",
];
for (const status of REQUIRED_HUE_CHANNEL_STATUS) {
  check(
    hueSource.includes(`"${status}"`),
    `hue status "${status}" defined`,
    `MISSING hue status "${status}" in hue.ts`
  );
}

console.log("\n[ Hue v1.4 403 uniformization ]");
check(
  hueSource.includes(`"AUTH_INVALID_RE_PAIR_REQUIRED"`),
  "hue runtime status AUTH_INVALID_RE_PAIR_REQUIRED defined",
  "MISSING hue runtime status AUTH_INVALID_RE_PAIR_REQUIRED"
);

console.log("\n[ Hue G7 pairing split ]");
const REQUIRED_HUE_PAIRING_CODES = [
  "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED",
  "HUE_PAIRING_DEVICETYPE_INVALID",
  "HUE_PAIRING_BRIDGE_BUSY",
  "HUE_PAIRING_RATE_LIMITED",
];
for (const code of REQUIRED_HUE_PAIRING_CODES) {
  check(
    hueSource.includes(`"${code}"`),
    `hue pairing code "${code}" defined`,
    `MISSING hue pairing code "${code}"`
  );
}
// Backwards-compat: the catch-all must survive the split.
check(
  hueSource.includes(`"HUE_PAIRING_FAILED"`),
  "hue pairing catch-all HUE_PAIRING_FAILED preserved",
  "MISSING backwards-compat HUE_PAIRING_FAILED"
);

console.log("\n[ Hue room archetypes ]");
check(
  hueSource.includes("HUE_ROOM_ARCHETYPES"),
  "HUE_ROOM_ARCHETYPES whitelist exported",
  "MISSING HUE_ROOM_ARCHETYPES whitelist"
);
check(
  hueSource.includes("HUE_ARCHETYPE_FALLBACK"),
  "HUE_ARCHETYPE_FALLBACK sentinel exported",
  "MISSING HUE_ARCHETYPE_FALLBACK sentinel"
);
// `other` must be present so the whitelist can fall back safely.
check(
  hueSource.includes(`"other"`),
  "HUE_ROOM_ARCHETYPES contains \"other\" fallback",
  "MISSING \"other\" fallback in HUE_ROOM_ARCHETYPES"
);

console.log("\n[ Hue intensity preset ]");
check(
  hueSource.includes("HUE_INTENSITY_PRESET_COEFFICIENTS"),
  "HUE_INTENSITY_PRESET_COEFFICIENTS map exported",
  "MISSING HUE_INTENSITY_PRESET_COEFFICIENTS"
);
check(
  hueSource.includes("DEFAULT_HUE_INTENSITY_PRESET"),
  "DEFAULT_HUE_INTENSITY_PRESET exported",
  "MISSING DEFAULT_HUE_INTENSITY_PRESET"
);

console.log("\n[ Hue zone re-export surface (v1.5 W4-F2) ]");
// After the W4-F2 reversal, hue.ts re-exports the canonical Hue zone
// surface from `roomMap.ts`. The literal command strings must NOT appear
// inline in `hue.ts` (they live in `roomMap.ts > HUE_ZONE_COMMANDS`); the
// re-export pointer must.
check(
  hueSource.includes("HUE_ZONE_COMMANDS"),
  "hue.ts re-exports HUE_ZONE_COMMANDS pointer",
  "MISSING HUE_ZONE_COMMANDS re-export in hue.ts"
);
check(
  hueSource.includes("HUE_ZONE_STATUS_CODES"),
  "hue.ts re-exports HUE_ZONE_STATUS_CODES pointer",
  "MISSING HUE_ZONE_STATUS_CODES re-export in hue.ts"
);
check(
  /export\s+type\s+HueZone\s*=/.test(hueSource),
  "hue.ts re-exports HueZone type alias from roomMap.ts",
  "MISSING HueZone type re-export in hue.ts"
);
check(
  !hueSource.includes(`"create_hue_zone"`)
    && !hueSource.includes(`"update_hue_zone"`)
    && !hueSource.includes(`"delete_hue_zone"`)
    && !hueSource.includes(`"assign_channel_to_hue_zone"`),
  "literal Hue zone command strings NOT inlined in hue.ts (live in roomMap.ts)",
  "STILL PRESENT: literal Hue zone command strings in hue.ts (move to roomMap.ts > HUE_ZONE_COMMANDS)"
);
check(
  !hueSource.includes(`"HUE_ZONE_CREATED"`)
    && !hueSource.includes(`"HUE_ZONE_UPDATED"`)
    && !hueSource.includes(`"HUE_ZONE_DELETED"`)
    && !hueSource.includes(`"HUE_ZONE_NOT_FOUND"`)
    && !hueSource.includes(`"HUE_ZONE_CHANNEL_OUT_OF_BOUNDS"`)
    && !hueSource.includes(`"HUE_ZONE_LIMIT_REACHED"`)
    && !hueSource.includes(`"HUE_ZONE_CHANNEL_NOT_IN_AREA"`)
    && !hueSource.includes(`"HUE_ZONE_OVERSIZED"`),
  "literal Hue zone status code strings NOT inlined in hue.ts",
  "STILL PRESENT: literal Hue zone status code strings in hue.ts (move to roomMap.ts > HUE_ZONE_STATUS_CODES)"
);

// ---------------------------------------------------------------------------
// Device contract
// ---------------------------------------------------------------------------
const DEVICE_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/device.ts");
const deviceSource = readOrEmpty(DEVICE_CONTRACT_FILE, "device");

console.log("\n[ Device serial health codes ]");
const REQUIRED_SERIAL_HEALTH_CODES = [
  "SERIAL_HEALTH_OK",
  "SERIAL_HEALTH_HANDSHAKE_TIMEOUT",
  "SERIAL_HEALTH_VERSION_MISMATCH",
  "SERIAL_HEALTH_FIRMWARE_MISMATCH",
  "SERIAL_HEALTH_PROTOCOL_ERROR",
];
for (const code of REQUIRED_SERIAL_HEALTH_CODES) {
  check(
    deviceSource.includes(`"${code}"`),
    `serial health code "${code}" defined`,
    `MISSING serial health code "${code}"`
  );
}

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
const RUST_HEALTH_CHECK_RESULT_FILE = resolve(
  ROOT,
  "src-tauri/src/commands/device_connection.rs"
);
const RUST_HEALTH_CHECK_API_FILE = resolve(
  ROOT,
  "src/features/device/deviceConnectionApi.ts"
);
const rustHealthSource = readOrEmpty(RUST_HEALTH_CHECK_RESULT_FILE, "rust device_connection");
const tsHealthApiSource = readOrEmpty(RUST_HEALTH_CHECK_API_FILE, "ts deviceConnectionApi");
check(
  deviceSource.includes("advertisedFirmwareProfile?: FirmwareProfile"),
  "device.ts SerialHealthReport.advertisedFirmwareProfile field declared",
  "MISSING device.ts SerialHealthReport.advertisedFirmwareProfile field"
);
check(
  tsHealthApiSource.includes("advertisedFirmwareProfile?: FirmwareProfile"),
  "deviceConnectionApi HealthCheckResult.advertisedFirmwareProfile field declared",
  "MISSING deviceConnectionApi HealthCheckResult.advertisedFirmwareProfile field"
);
check(
  rustHealthSource.includes("pub advertised_firmware_profile: Option<FirmwareProfile>"),
  "Rust HealthCheckResult.advertised_firmware_profile field declared",
  "MISSING Rust HealthCheckResult.advertised_firmware_profile field"
);

console.log("\n[ Device sample-LED-frame command ]");
check(
  deviceSource.includes(`"sample_led_frame"`),
  "device command \"sample_led_frame\" defined",
  "MISSING device command \"sample_led_frame\""
);

// ---------------------------------------------------------------------------
// Calibration contract (shared extract)
// ---------------------------------------------------------------------------
const CALIBRATION_CONTRACT_FILE = resolve(
  ROOT,
  "src/shared/contracts/calibration.ts"
);
const calibrationSource = readOrEmpty(CALIBRATION_CONTRACT_FILE, "calibration");

console.log("\n[ Calibration shared contract ]");
const REQUIRED_CALIBRATION_EXPORTS = [
  "LedCalibrationConfig",
  "LedSegmentCounts",
  "LedDirection",
  "LedStartAnchor",
];
for (const name of REQUIRED_CALIBRATION_EXPORTS) {
  check(
    calibrationSource.includes(name),
    `calibration export "${name}" present`,
    `MISSING calibration export "${name}"`
  );
}

// ---------------------------------------------------------------------------
// Platform contract (new v1.4 surface)
// ---------------------------------------------------------------------------
const PLATFORM_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/platform.ts");
const platformSource = readOrEmpty(PLATFORM_CONTRACT_FILE, "platform");

console.log("\n[ Platform notification commands ]");
const REQUIRED_PLATFORM_COMMANDS = [
  "request_notification_permission",
  "show_notification",
];
for (const cmd of REQUIRED_PLATFORM_COMMANDS) {
  check(
    platformSource.includes(`"${cmd}"`),
    `platform command "${cmd}" defined`,
    `MISSING platform command "${cmd}" in platform.ts`
  );
}

console.log("\n[ Notification kinds ]");
const REQUIRED_NOTIFICATION_KINDS = ["info", "warn", "error"];
for (const kind of REQUIRED_NOTIFICATION_KINDS) {
  check(
    platformSource.includes(`"${kind}"`),
    `notification kind "${kind}" defined`,
    `MISSING notification kind "${kind}"`
  );
}

console.log("\n[ Notification result codes ]");
const REQUIRED_NOTIFICATION_RESULT_CODES = [
  "NOTIF_PERMISSION_GRANTED",
  "NOTIF_PERMISSION_DENIED",
  "NOTIF_UNSUPPORTED_OS",
];
for (const code of REQUIRED_NOTIFICATION_RESULT_CODES) {
  check(
    platformSource.includes(`"${code}"`),
    `notification result code "${code}" defined`,
    `MISSING notification result code "${code}"`
  );
}

// ---------------------------------------------------------------------------
// Room map contract
// ---------------------------------------------------------------------------
const ROOM_MAP_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/roomMap.ts");
const roomMapSource = readOrEmpty(ROOM_MAP_CONTRACT_FILE, "room map");

console.log("\n[ Room map contract types ]");
// `ZoneDefinition` and `LegacyHueZone` survive as @deprecated migration-shim
// types (consumed by `migrateLegacyHueZone` and the W4-F2 logical-drop path);
// `HueZone` is the canonical authoring type and MUST be present alongside
// them.
const REQUIRED_ROOM_MAP_TYPES = [
  "RoomDimensions",
  "HueChannelPlacement",
  "UsbStripPlacement",
  "FurniturePlacement",
  "TvAnchorPlacement",
  "ZoneDefinition",
  "LegacyHueZone",
  "HueZone",
  "RoomMapConfig",
];
for (const typeName of REQUIRED_ROOM_MAP_TYPES) {
  check(
    roomMapSource.includes(`export interface ${typeName}`),
    `room map type "${typeName}" exported`,
    `MISSING room map type "${typeName}" in roomMap.ts`
  );
}

console.log("\n[ Room map commands ]");
const REQUIRED_ROOM_MAP_COMMANDS = [
  "save_room_map",
  "load_room_map",
];
for (const cmd of REQUIRED_ROOM_MAP_COMMANDS) {
  check(
    roomMapSource.includes(`"${cmd}"`),
    `room map command "${cmd}" defined`,
    `MISSING room map command "${cmd}" in roomMap.ts`
  );
}

// ---------------------------------------------------------------------------
// Hue zone surface (v1.5 W4-F2 — Hue-only after the direction reversal)
// ---------------------------------------------------------------------------
console.log("\n[ Hue zone — canonical type shape (v1.5 W4-F2) ]");
// `HueZone` is now Hue-only; the W4-F-era `zoneType` discriminator is gone,
// so the Hue-required fields are non-optional on the canonical type.
check(
  /export\s+interface\s+HueZone\b/.test(roomMapSource),
  "HueZone interface present in roomMap.ts",
  "MISSING HueZone interface in roomMap.ts"
);
const HUE_ZONE_REQUIRED_FIELDS = [
  ["entertainmentAreaId", "string"],
  ["centerX", "number"],
  ["centerY", "number"],
  ["centerZ", "number"],
  ["scaleX", "number"],
  ["scaleY", "number"],
  ["scaleZ", "number"],
];
// Slice the HueZone block so we only check fields inside that interface.
const hueZoneBlockMatch = roomMapSource.match(
  /export\s+interface\s+HueZone\b[\s\S]*?\n\}/,
);
const hueZoneBlock = hueZoneBlockMatch ? hueZoneBlockMatch[0] : "";
for (const [field, ty] of HUE_ZONE_REQUIRED_FIELDS) {
  // Required (no `?:`). Match `field: ty` — allow trailing semicolon /
  // newline / comment.
  const re = new RegExp(`\\b${field}:\\s*${ty}\\b`);
  check(
    re.test(hueZoneBlock),
    `HueZone.${field} declared required (${ty})`,
    `HueZone.${field} not declared required ${ty} (W4-F2: Hue-only fields lost their optional marker)`
  );
}
// `zoneType` discriminator MUST be gone from the canonical HueZone block.
check(
  !/zoneType\s*[?:]/.test(hueZoneBlock),
  "HueZone.zoneType discriminator removed (W4-F2 direction reversal)",
  "HueZone.zoneType discriminator still present — W4-F2 cleanup incomplete"
);

console.log("\n[ Hue zone — legacy migration shape (v1.5 W4-F2) ]");
check(
  /export\s+interface\s+LegacyHueZone\b/.test(roomMapSource),
  "LegacyHueZone interface present (read-only migration shape)",
  "MISSING LegacyHueZone interface in roomMap.ts"
);

console.log("\n[ Hue zone — RoomMapConfig fields (v1.5 W4-F2) ]");
check(
  /zones:\s*HueZone\[\]/.test(roomMapSource),
  "RoomMapConfig.zones typed HueZone[] (Hue-only, post-W4-F2)",
  "RoomMapConfig.zones is not typed HueZone[] (W4-F2 cleanup incomplete)"
);
check(
  /hueZones\?:\s*LegacyHueZone\[\]/.test(roomMapSource),
  "RoomMapConfig.hueZones kept as @deprecated LegacyHueZone[] fallback",
  "MISSING @deprecated RoomMapConfig.hueZones field — F6 migration shim has no fallback to read"
);

console.log("\n[ Hue zone — migration helper (v1.5 W4-F2) ]");
check(
  /export\s+function\s+migrateLegacyHueZone\s*\(/.test(roomMapSource),
  "migrateLegacyHueZone helper exported (Hue-only)",
  "MISSING migrateLegacyHueZone helper in roomMap.ts"
);
// The W4-F-era `toLogicalZone` and `toHueZone` helpers MUST be gone (the
// brief logical-zone migration path was rolled back in W4-F2).
check(
  !/export\s+function\s+toLogicalZone\b/.test(roomMapSource),
  "toLogicalZone helper removed (W4-F2 direction reversal)",
  "STILL PRESENT: toLogicalZone helper — W4-F2 cleanup incomplete"
);
check(
  !/export\s+function\s+toHueZone\b/.test(roomMapSource),
  "toHueZone helper removed (renamed to migrateLegacyHueZone)",
  "STILL PRESENT: toHueZone helper — should be renamed to migrateLegacyHueZone"
);
check(
  !/export\s+function\s+asHueZoneLegacy\b/.test(roomMapSource),
  "asHueZoneLegacy projection removed (W4-F2: HueZone is canonical, no projection needed)",
  "STILL PRESENT: asHueZoneLegacy projection — should be deleted in W4-F2"
);

console.log("\n[ Hue zone — discriminator surface removed (v1.5 W4-F2) ]");
// `ZONE_TYPES` / `ZoneType` were the W4-F unification's discriminator — both
// must be gone after the direction reversal.
check(
  !/export\s+const\s+ZONE_TYPES\b/.test(roomMapSource),
  "ZONE_TYPES const removed (W4-F2 reversal)",
  "STILL PRESENT: ZONE_TYPES const — discriminator should be gone in W4-F2"
);
check(
  !/export\s+type\s+ZoneType\b/.test(roomMapSource),
  "ZoneType type removed (W4-F2 reversal)",
  "STILL PRESENT: ZoneType type — discriminator should be gone in W4-F2"
);
// The brief generic `ZONE_COMMANDS` / `ZONE_STATUS_CODES` maps were renamed
// back to the Hue-only `HUE_ZONE_*` family in W4-F2.
check(
  !/export\s+const\s+ZONE_COMMANDS\b/.test(roomMapSource),
  "generic ZONE_COMMANDS map removed (W4-F2 reversal)",
  "STILL PRESENT: generic ZONE_COMMANDS map — should be HUE_ZONE_COMMANDS after W4-F2"
);
check(
  !/export\s+const\s+ZONE_STATUS_CODES\b/.test(roomMapSource),
  "generic ZONE_STATUS_CODES map removed (W4-F2 reversal)",
  "STILL PRESENT: generic ZONE_STATUS_CODES map — should be HUE_ZONE_STATUS_CODES after W4-F2"
);
// Brief W4-F-only status codes that only made sense in a logical/Hue
// discriminated world.
check(
  !roomMapSource.includes(`"ZONE_TYPE_INVALID"`),
  "ZONE_TYPE_INVALID status code removed (W4-F2 reversal)",
  "STILL PRESENT: ZONE_TYPE_INVALID — only meaningful when discriminator existed"
);
check(
  !roomMapSource.includes(`"ZONE_CONVERSION_OK"`),
  "ZONE_CONVERSION_OK status code removed (W4-F2 reversal)",
  "STILL PRESENT: ZONE_CONVERSION_OK — only meaningful for hue → logical conversion path"
);

console.log("\n[ Hue zone — command surface (v1.5 W4-F2) ]");
const REQUIRED_HUE_ZONE_COMMANDS = [
  "create_hue_zone",
  "update_hue_zone",
  "delete_hue_zone",
  "assign_channel_to_hue_zone",
];
for (const cmd of REQUIRED_HUE_ZONE_COMMANDS) {
  check(
    roomMapSource.includes(`"${cmd}"`),
    `hue zone command "${cmd}" defined in roomMap.ts`,
    `MISSING hue zone command "${cmd}" in roomMap.ts > HUE_ZONE_COMMANDS`
  );
}
check(
  /export\s+const\s+HUE_ZONE_COMMANDS\s*=\s*\{/.test(roomMapSource),
  "HUE_ZONE_COMMANDS const exported (Hue-only, post-W4-F2)",
  "MISSING HUE_ZONE_COMMANDS const in roomMap.ts"
);

console.log("\n[ Hue zone — status codes (v1.5 W4-F2) ]");
const REQUIRED_HUE_ZONE_STATUS_CODES = [
  "HUE_ZONE_CREATED",
  "HUE_ZONE_UPDATED",
  "HUE_ZONE_DELETED",
  "HUE_ZONE_NOT_FOUND",
  "HUE_ZONE_CHANNEL_OUT_OF_BOUNDS",
  "HUE_ZONE_LIMIT_REACHED",
  "HUE_ZONE_CHANNEL_NOT_IN_AREA",
  "HUE_ZONE_OVERSIZED",
];
for (const code of REQUIRED_HUE_ZONE_STATUS_CODES) {
  check(
    roomMapSource.includes(`"${code}"`),
    `hue zone status code "${code}" defined`,
    `MISSING hue zone status code "${code}" in roomMap.ts > HUE_ZONE_STATUS_CODES`
  );
}
check(
  /export\s+const\s+HUE_ZONE_STATUS_CODES\s*=\s*\{/.test(roomMapSource),
  "HUE_ZONE_STATUS_CODES const exported (Hue-only, post-W4-F2)",
  "MISSING HUE_ZONE_STATUS_CODES const in roomMap.ts"
);

// ---------------------------------------------------------------------------
// Rust handler parity for the renamed Hue zone commands (v1.5 W4-F2).
//
// `lib.rs` registers Tauri commands through `generate_handler!` — the
// post-W4-F2 verbs (`create_hue_zone`, `update_hue_zone`, `delete_hue_zone`,
// `assign_channel_to_hue_zone`) MUST appear in that list, otherwise the
// frontend's `invoke(HUE_ZONE_COMMANDS.X)` call resolves to nothing. The
// brief W4-F-era generic `create_zone` / `update_zone` etc. handlers MUST
// be gone.
// ---------------------------------------------------------------------------
const RUST_LIB_FILE = resolve(ROOT, "src-tauri/src/lib.rs");
const rustLibSource = readOrEmpty(RUST_LIB_FILE, "rust lib.rs");

console.log("\n[ Hue zone — Rust handler parity (v1.5 W4-F2) ]");
const REQUIRED_RUST_HUE_ZONE_HANDLERS = [
  "create_hue_zone",
  "update_hue_zone",
  "delete_hue_zone",
  "assign_channel_to_hue_zone",
];
const handlerListMatch = rustLibSource.match(/generate_handler!\[([\s\S]*?)\]/);
const handlerListBlock = handlerListMatch ? handlerListMatch[1] : "";
for (const fn of REQUIRED_RUST_HUE_ZONE_HANDLERS) {
  const re = new RegExp(`(^|[\\s,])${fn}([\\s,]|$)`, "m");
  check(
    re.test(handlerListBlock),
    `Rust generate_handler! list registers "${fn}"`,
    `MISSING Rust generate_handler! entry for "${fn}" — `
      + `frontend invoke(HUE_ZONE_COMMANDS.X) will resolve to nothing`
  );
}
// Brief W4-F-era handler names MUST be gone.
const LEGACY_W4F_HANDLERS = [
  "create_zone",
  "update_zone",
  "delete_zone",
  "assign_channel_to_zone",
];
for (const fn of LEGACY_W4F_HANDLERS) {
  const re = new RegExp(`(^|[\\s,])${fn}([\\s,]|$)`, "m");
  check(
    !re.test(handlerListBlock),
    `legacy W4-F Rust handler "${fn}" removed from generate_handler! list`,
    `STILL PRESENT: legacy W4-F Rust handler "${fn}" — partial rename detected`
  );
}

// ---------------------------------------------------------------------------
// Device WLED status codes (v1.5.2 patch — F4 + A2.2)
// ---------------------------------------------------------------------------
const WLED_DISCOVERY_FILE = resolve(
  ROOT,
  "src-tauri/src/commands/wled_discovery.rs"
);
const wledRustSource = readOrEmpty(WLED_DISCOVERY_FILE, "wled_discovery.rs");

console.log("\n[ Device WLED status codes (v1.5.2 patch — F4) ]");
const REQUIRED_WLED_STATUS_CODES = [
  "WLED_DISCOVERY_OK",
  "WLED_DISCOVERY_EMPTY",
  "WLED_DISCOVERY_TIMEOUT",
  "WLED_BRIDGE_UNREACHABLE",
  "WLED_PROTOCOL_MISMATCH",
  "WLED_LED_COUNT_MISMATCH",
  "WLED_INVALID_IP",
  // A2.2: led_count=0 guard
  "WLED_INVALID_LED_COUNT",
];
for (const code of REQUIRED_WLED_STATUS_CODES) {
  check(
    deviceSource.includes(`"${code}"`),
    `WLED_STATUS map contains "${code}" (device.ts)`,
    `MISSING WLED_STATUS entry "${code}" in device.ts`
  );
}
// Rust side must also declare every code that the frontend sees.
for (const code of REQUIRED_WLED_STATUS_CODES) {
  // Not all codes appear in the discovery file (DISCOVERY_EMPTY is TS-only for
  // the mDNS path), so we only require the ones that Rust actively emits.
  const RUST_EMITTED = [
    "WLED_DISCOVERY_OK",
    "WLED_DISCOVERY_TIMEOUT",
    "WLED_BRIDGE_UNREACHABLE",
    "WLED_PROTOCOL_MISMATCH",
    "WLED_LED_COUNT_MISMATCH",
    "WLED_INVALID_IP",
    "WLED_INVALID_LED_COUNT",
  ];
  if (RUST_EMITTED.includes(code)) {
    check(
      wledRustSource.includes(`"${code}"`),
      `Rust wled_discovery.rs emits status code "${code}"`,
      `MISSING status code "${code}" in wled_discovery.rs`
    );
  }
}

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
const WLED_API_FILE = resolve(ROOT, "src/features/device/wledApi.ts");
const wledApiTsSource = readOrEmpty(WLED_API_FILE, "wledApi.ts");
check(
  deviceSource.includes("devices: WledDeviceInfo[]") ||
    wledApiTsSource.includes("devices: WledDeviceInfo[]"),
  "TS WledDiscoveryResponse.devices is WledDeviceInfo[] (wledApi.ts or device.ts)",
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

console.log("\n[ WLED test response — roundTripMs (A1.6) ]");
check(
  wledRustSource.includes("pub round_trip_ms: Option<u64>"),
  "WledTestResponse.round_trip_ms: Option<u64> present in Rust",
  "MISSING: WledTestResponse.round_trip_ms field — A1.6 test response fix incomplete"
);
check(
  !wledRustSource.match(/pub struct WledTestResponse[^}]*pub device:/s),
  "Old WledTestResponse.device field removed (A1.6)",
  "STILL PRESENT: WledTestResponse.device field — A1.6 cleanup incomplete"
);

console.log("\n[ WLED SSRF guard — extended address range checks (A2.1) ]");
check(
  wledRustSource.includes("is_loopback()"),
  "parse_ipv4 rejects loopback (127.x) via is_loopback()",
  "MISSING: is_loopback() check in parse_ipv4"
);
check(
  wledRustSource.includes("is_unspecified()"),
  "parse_ipv4 rejects unspecified (0.0.0.0) via is_unspecified()",
  "MISSING: is_unspecified() check in parse_ipv4"
);
check(
  wledRustSource.includes("is_multicast()"),
  "parse_ipv4 rejects multicast (224.x/4) via is_multicast()",
  "MISSING: is_multicast() check in parse_ipv4"
);
check(
  wledRustSource.includes("is_broadcast()"),
  "parse_ipv4 rejects broadcast (255.255.255.255) via is_broadcast()",
  "MISSING: is_broadcast() check in parse_ipv4"
);

// ---------------------------------------------------------------------------
// LED Preview & Test Experience contract (v1.6 — Phase 0, contracts only)
//
// Phase 0 lands the TypeScript surface only; the 8 Rust #[tauri::command]
// handlers arrive in Phase 1. The presence checks below (command strings,
// status codes, event/window labels, tray id, ShellState fields) are real
// assertions and pass today. The Rust-parity loop treats the 8 preview
// commands as a KNOWN-PENDING allowlist: a command not yet registered in
// `generate_handler!` is surfaced via note() as PENDING (not failed) so
// Phase 0 stays green, while a command that IS registered passes (and nudges
// the maintainer to prune the allowlist). When Phase 1 registers all 8,
// empty PREVIEW_PENDING_RUST_HANDLERS and the loop enforces strict parity
// exactly like the Hue zone block above.
// ---------------------------------------------------------------------------
const PREVIEW_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/preview.ts");
const previewSource = readOrEmpty(PREVIEW_CONTRACT_FILE, "preview");

console.log("\n[ Preview commands (v1.6) ]");
const REQUIRED_PREVIEW_COMMANDS = [
  "start_led_test_pattern",
  "stop_led_test_pattern",
  "get_led_preview_status",
  "open_led_twin_overlay",
  "close_led_twin_overlay",
  "open_led_control_popup",
  "show_led_control_popup",
  "hide_led_control_popup",
];
for (const cmd of REQUIRED_PREVIEW_COMMANDS) {
  check(
    previewSource.includes(`"${cmd}"`),
    `preview command "${cmd}" defined in preview.ts`,
    `MISSING preview command "${cmd}" in preview.ts > PREVIEW_COMMANDS`
  );
}

console.log("\n[ Preview status codes (v1.6) ]");
const REQUIRED_PREVIEW_STATUS_CODES = [
  // LED test pattern lifecycle
  "LED_TEST_PATTERN_STARTED",
  "LED_TEST_PATTERN_PREVIEW_ONLY",
  "LED_TEST_PATTERN_STOPPED",
  "LED_TEST_PATTERN_INVALID_PARAMS",
  "LED_TEST_PATTERN_NO_CALIBRATION",
  "LED_TEST_PATTERN_RUNTIME_ERROR",
  // Twin overlay window
  "TWIN_OVERLAY_OPENED",
  "TWIN_OVERLAY_CLOSED",
  "TWIN_OVERLAY_OPEN_FAILED",
  "TWIN_OVERLAY_DISPLAY_NOT_FOUND",
  "TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE",
  // Control popup window
  "CONTROL_POPUP_OPENED",
  "CONTROL_POPUP_SHOWN",
  "CONTROL_POPUP_HIDDEN",
  "CONTROL_POPUP_FAILED",
];
for (const code of REQUIRED_PREVIEW_STATUS_CODES) {
  check(
    previewSource.includes(`"${code}"`),
    `preview status code "${code}" defined`,
    `MISSING preview status code "${code}" in preview.ts`
  );
}

console.log("\n[ Preview event + window labels (v1.6) ]");
check(
  previewSource.includes(`"preview://state-changed"`),
  "PREVIEW_STATE_CHANGED_EVENT defined",
  "MISSING PREVIEW_STATE_CHANGED_EVENT in preview.ts"
);
check(
  previewSource.includes(`"led-twin-overlay-"`),
  "LED_TWIN_OVERLAY_LABEL_PREFIX defined",
  "MISSING LED_TWIN_OVERLAY_LABEL_PREFIX in preview.ts"
);
check(
  previewSource.includes(`"led-control-popup"`),
  "LED_CONTROL_POPUP_LABEL defined",
  "MISSING LED_CONTROL_POPUP_LABEL in preview.ts"
);

console.log("\n[ Preview tray menu id (v1.6) ]");
check(
  source.includes(`"tray-show-led-preview"`),
  'TRAY_MENU_IDS.SHOW_LED_PREVIEW ("tray-show-led-preview") defined',
  'MISSING tray id "tray-show-led-preview" in shell.ts'
);

console.log("\n[ ShellState v1.6 preview additions ]");
const REQUIRED_V16_STATE_FIELDS = [
  "ledPreviewPopupVisible",
  "ledPreviewPopupCenterX",
  "ledPreviewPopupCenterY",
  "ledTwinEnabledTest",
  "lastLedTestPattern",
  "ledPreviewHintShown",
];
for (const field of REQUIRED_V16_STATE_FIELDS) {
  check(
    source.includes(field + "?:"),
    `ShellState v1.6 field "${field}" declared optional`,
    `MISSING optional ShellState v1.6 field "${field}"`
  );
}

console.log("\n[ Preview — Rust handler parity (v1.6 Phase 0 \u2192 Phase 1) ]");
// Phase 0 known-pending allowlist. The Rust handlers land in Phase 1; remove
// an entry the moment its #[tauri::command] is registered in lib.rs. When this
// array is empty the loop enforces strict parity like the Hue zone block above.
const PREVIEW_PENDING_RUST_HANDLERS = [];
for (const fn of REQUIRED_PREVIEW_COMMANDS) {
  const re = new RegExp(`(^|[\\s,])${fn}([\\s,]|$)`, "m");
  const registered = re.test(handlerListBlock);
  const pending = PREVIEW_PENDING_RUST_HANDLERS.includes(fn);
  if (registered) {
    pass(`Rust generate_handler! list registers "${fn}"`);
    if (pending) {
      note(
        `"${fn}" is now registered in lib.rs — remove it from `
          + `PREVIEW_PENDING_RUST_HANDLERS (Phase 1 cleanup)`
      );
    }
  } else if (pending) {
    note(
      `PENDING (Phase 1): "${fn}" not yet in generate_handler! — `
        + `known-pending allowlist, not a failure`
    );
  } else {
    fail(
      `MISSING Rust generate_handler! entry for "${fn}" — `
        + `frontend invoke(PREVIEW_COMMANDS.X) will resolve to nothing`
    );
  }
}

// ---------------------------------------------------------------------------
// Lighting-mode status codes — derived Rust → TS parity. Only literal first
// args count; the preview call sites pass a constant and belong to preview.ts.
// ---------------------------------------------------------------------------
const LIGHTING_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/lighting.ts");
const RUST_LIGHTING_MODE_FILE = resolve(ROOT, "src-tauri/src/commands/lighting_mode.rs");
const lightingSource = readOrEmpty(LIGHTING_CONTRACT_FILE, "lighting");
const rustLightingSource = readOrEmpty(RUST_LIGHTING_MODE_FILE, "rust lighting_mode");

console.log("\n[ Lighting-mode status codes — Rust → lighting.ts parity ]");
const rustLightingProduction = rustLightingSource.split(/\nmod tests\s*\{/)[0];
const emittedLightingCodes = [
  ...new Set(
    [...rustLightingProduction.matchAll(/command_status\(\s*"([A-Z][A-Z0-9_]*)"/g)]
      .map((m) => m[1])
  ),
].sort();
// Pinned, not `> 0`: the harvest sees string literals only, so hoisting a code
// to a `const` (the shape preview.rs already uses) would silently drop it while
// the other nine still matched. Bump this deliberately when a code is added.
const EXPECTED_LIGHTING_CODE_COUNT = 10;
check(
  emittedLightingCodes.length === EXPECTED_LIGHTING_CODE_COUNT,
  `harvested exactly ${EXPECTED_LIGHTING_CODE_COUNT} command_status codes from lighting_mode.rs`,
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
// Runtime telemetry — derived Rust → TS field parity
// ---------------------------------------------------------------------------
const TELEMETRY_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/telemetry.ts");
const RUST_TELEMETRY_FILE = resolve(ROOT, "src-tauri/src/commands/runtime_telemetry.rs");
const telemetrySource = readOrEmpty(TELEMETRY_CONTRACT_FILE, "telemetry");
const rustTelemetrySource = readOrEmpty(RUST_TELEMETRY_FILE, "rust runtime_telemetry");

function rustStructFields(source, structName) {
  const block = source.match(
    new RegExp(`pub struct ${structName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  );
  if (!block) return null;
  return [...block[1].matchAll(/^\s*pub\s+([a-z0-9_]+)\s*:/gm)].map((m) =>
    m[1].replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
  );
}

console.log("\n[ Runtime telemetry — Rust → telemetry.ts field parity ]");
// Same degradation shape as the lighting harvest: a removed Rust field silently
// stops being checked. Pin the count so the loop cannot quietly narrow.
const EXPECTED_TELEMETRY_FIELD_COUNTS = {
  RuntimeTelemetrySnapshot: 6,
  HueTelemetrySnapshot: 11,
  FullTelemetrySnapshot: 2,
};
for (const [structName, expectedCount] of Object.entries(EXPECTED_TELEMETRY_FIELD_COUNTS)) {
  const fields = rustStructFields(rustTelemetrySource, structName);
  if (!fields || fields.length === 0) {
    fail(`EXTRACTION FAILED: no fields found on Rust struct "${structName}"`);
    continue;
  }
  check(
    fields.length === expectedCount,
    `${structName} harvested exactly ${expectedCount} fields`,
    `HARVEST COUNT DRIFT: expected ${expectedCount} fields on ${structName}, got `
      + `${fields.length} [${fields.join(", ")}] — update the pin deliberately`
  );
  const tsBlock = telemetrySource.match(
    new RegExp(`export interface ${structName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  );
  if (!tsBlock) {
    fail(`MISSING interface "${structName}" in telemetry.ts`);
    continue;
  }
  for (const field of fields) {
    check(
      new RegExp(`^\\s*${field}\\??\\s*:`, "m").test(tsBlock[1]),
      `${structName}.${field} declared in telemetry.ts`,
      `MISSING ${structName}.${field} in telemetry.ts — Rust serializes it `
        + `(#[serde(rename_all = "camelCase")]) but the contract drops it`
    );
  }
}

// Both semantics are invisible in the types: 0 means "no serial link", and
// `linkConstrained` tracks material degradation, not the stricter send-clamp.
console.log("\n[ Runtime telemetry — link-budget semantics ]");
check(
  telemetrySource.includes("LINK_MAX_FPS_ABSENT"),
  "LINK_MAX_FPS_ABSENT sentinel exported (0 ≠ zero fps)",
  "MISSING LINK_MAX_FPS_ABSENT in telemetry.ts — nothing stops a consumer "
    + "rendering a Hue-only session as \"0 fps\""
);
const rustLinkThreshold = rustLightingSource.match(
  /const\s+LINK_CONSTRAINED_FPS\s*:\s*f32\s*=\s*([0-9.]+)/
);
const tsLinkThreshold = telemetrySource.match(
  /LINK_CONSTRAINED_FPS_THRESHOLD\s*=\s*([0-9.]+)/
);
check(
  rustLinkThreshold !== null
    && tsLinkThreshold !== null
    && Number(rustLinkThreshold[1]) === Number(tsLinkThreshold[1]),
  `link-constrained threshold matches Rust LINK_CONSTRAINED_FPS `
    + `(${rustLinkThreshold ? rustLinkThreshold[1] : "?"})`,
  `THRESHOLD DRIFT: Rust LINK_CONSTRAINED_FPS=${rustLinkThreshold ? rustLinkThreshold[1] : "?"} `
    + `vs telemetry.ts LINK_CONSTRAINED_FPS_THRESHOLD=${tsLinkThreshold ? tsLinkThreshold[1] : "?"}`
);

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

// ---------------------------------------------------------------------------
// Highest severity: a code both trees use and neither declares. Both sides
// believe they own it and neither is authoritative — how a word-swap survives.
// ---------------------------------------------------------------------------
console.log("\n[ Status codes present in BOTH trees, declared in NEITHER ]");

function walkSourceFiles(dir, match, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, match, out);
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

// A prose mention is not a declaration — the miss that hid DEVICE_NOT_CONNECTED
// behind three comments. Biased toward false positives on purpose.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function harvestCodes(files) {
  const found = new Set();
  for (const file of files) {
    let text = stripComments(readFileSync(file, "utf-8"));
    // The test MODULE, not any `#[cfg(test)]` — four files carry that attribute
    // on a plain item, which truncated lighting_mode.rs at line 58 of ~3400.
    if (file.endsWith(".rs")) text = text.split(/\n#\[cfg\(test\)\]\s*\nmod /)[0];
    // `"CODE: detail"` counts too — Err arms carry the code as a prefix (#42).
    for (const m of text.matchAll(/"([A-Z][A-Z0-9_]{4,})(?:"|:\s)/g)) {
      const code = m[1];
      // Underscore-required drops CLOCKWISE/TEXTAREA without an allowlist that
      // rots; a trailing one marks a `.startsWith()` prefix, not a code.
      if (!code.includes("_") || code.endsWith("_")) continue;
      found.add(code);
    }
  }
  return found;
}

const tsSourceFiles = walkSourceFiles(resolve(ROOT, "src"), /\.tsx?$/);
// Whole crate, not just `commands/`: `network/mdns.rs` emits the HUE_MDNS_*
// codes, and a narrower root reports them as phantoms.
const rustEmitted = harvestCodes(
  walkSourceFiles(resolve(ROOT, "src-tauri/src"), /\.rs$/)
);
const tsReferenced = harvestCodes(
  tsSourceFiles.filter((f) => !f.includes("/shared/contracts/"))
);
const contractDeclared = harvestCodes(
  tsSourceFiles.filter((f) => f.includes("/shared/contracts/"))
);

const inBothTrees = [...rustEmitted].filter((c) => tsReferenced.has(c)).sort();
const undeclaredInBoth = inBothTrees.filter((c) => !contractDeclared.has(c));
// Floor the two harvests that only grow. NOT the intersection: replacing a raw
// TS literal with an imported constant is the fix we want, and it removes that
// code from `tsReferenced` — so the intersection shrinks as the tree improves.
const MIN_RUST_EMITTED_CODES = 130;
const MIN_CONTRACT_DECLARED_CODES = 120;
check(
  rustEmitted.size >= MIN_RUST_EMITTED_CODES,
  `harvested ${rustEmitted.size} Rust codes (floor ${MIN_RUST_EMITTED_CODES})`,
  `HARVEST DEGRADED: only ${rustEmitted.size} Rust codes seen — the regex or the `
    + `walk stopped matching; every check below is now weaker than it looks`
);
check(
  contractDeclared.size >= MIN_CONTRACT_DECLARED_CODES,
  `harvested ${contractDeclared.size} declared codes (floor ${MIN_CONTRACT_DECLARED_CODES})`,
  `HARVEST DEGRADED: only ${contractDeclared.size} declared codes seen in contracts/`
);
note(`${inBothTrees.length} codes still cross the wire as raw TS literals`);
for (const code of undeclaredInBoth) {
  fail(
    `BOTH-TREES UNDECLARED "${code}" — Rust emits it and TS reads it, but no `
      + `contract declares it. Neither side is authoritative.`
  );
}
check(
  undeclaredInBoth.length === 0,
  "every code crossing the wire is declared in a contract",
  `${undeclaredInBoth.length} wire codes undeclared (listed above)`
);

// ---------------------------------------------------------------------------
// Declared in a contract, emitted by no Rust producer. Ratcheted — the baseline
// may only shrink. See contract-phantom-baseline.txt.
// ---------------------------------------------------------------------------
console.log("\n[ Declared codes with no Rust producer (ratcheted) ]");
const PHANTOM_BASELINE_FILE = resolve(__dirname, "contract-phantom-baseline.txt");
const phantomBaseline = new Set(
  readOrEmpty(PHANTOM_BASELINE_FILE, "phantom baseline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
);

const declaredWithoutProducer = [...contractDeclared]
  .filter((code) => !rustEmitted.has(code))
  .sort();

for (const code of declaredWithoutProducer) {
  if (phantomBaseline.has(code)) {
    note(`KNOWN GAP: "${code}" declared with no Rust producer (baselined)`);
  } else {
    fail(
      `NEW PHANTOM "${code}" — declared in a contract but no Rust file emits it. `
        + `Either wire up the producer or drop the declaration; do not baseline it `
        + `without establishing which.`
    );
  }
}

// The half that makes it a ratchet rather than a suppression list.
for (const code of phantomBaseline) {
  check(
    !rustEmitted.has(code),
    `baseline entry "${code}" still has no producer`,
    `BASELINE STALE: "${code}" now HAS a Rust producer — delete its line from `
      + `contract-phantom-baseline.txt (the file may only shrink)`
  );
}
check(
  declaredWithoutProducer.filter((c) => !phantomBaseline.has(c)).length === 0,
  `no new phantoms beyond the ${phantomBaseline.size} baselined`,
  "new phantoms found (listed above)"
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n====================================`);
if (errors === 0) {
  console.log(`✔  All ${checks} checks passed — shell contracts verified.\n`);
  process.exit(0);
} else {
  console.error(
    `✘  ${errors} of ${checks} checks FAILED — shell contracts incomplete.\n`
  );
  process.exit(1);
}
