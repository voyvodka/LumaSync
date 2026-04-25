#!/usr/bin/env node
/**
 * Phase 01 Shell Contracts Verifier
 *
 * Fails (exit 1) if required exports, section IDs, error codes, or
 * command strings drift across `src/shared/contracts/*.ts`.
 *
 * Usage: node scripts/verify/phase01-shell-contracts.mjs
 */

import { readFileSync } from "fs";
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
  "windowWidth",
  "windowHeight",
  "windowX",
  "windowY",
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
    `MISSING platform command "${cmd}"`
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
const REQUIRED_ROOM_MAP_TYPES = [
  "RoomDimensions",
  "HueChannelPlacement",
  "UsbStripPlacement",
  "FurniturePlacement",
  "TvAnchorPlacement",
  "ZoneDefinition",
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
