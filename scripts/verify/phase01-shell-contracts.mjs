#!/usr/bin/env node
/**
 * Phase 01 Shell Contracts Verifier
 *
 * Fails (exit 1) if required exports or section IDs are missing from
 * src/shared/contracts/shell.ts, acting as a deterministic gate
 * for downstream tasks.
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
  "DEFAULT_SHELL_STATE",
  "SHELL_STORE_KEY",
  "WINDOW_MIN_WIDTH",
  "WINDOW_MIN_HEIGHT",
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

// Read hue contract file
const HUE_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/hue.ts");
let hueSource;
try {
  hueSource = readFileSync(HUE_CONTRACT_FILE, "utf-8");
} catch (err) {
  console.error(`\nWARN: Cannot read hue contract file: ${HUE_CONTRACT_FILE}`);
  hueSource = "";
}

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

// Read room map contract file
const ROOM_MAP_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/roomMap.ts");
let roomMapSource;
try {
  roomMapSource = readFileSync(ROOM_MAP_CONTRACT_FILE, "utf-8");
} catch (err) {
  console.error(`\nWARN: Cannot read room map contract file: ${ROOM_MAP_CONTRACT_FILE}`);
  roomMapSource = "";
}

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
