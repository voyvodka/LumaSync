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
  "startup-toggle",
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
