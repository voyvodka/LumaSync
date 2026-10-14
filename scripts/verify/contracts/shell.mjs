import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

import { ROOT, check, walkSourceFiles, walkRustSourceFiles, stripComments } from "./lib.mjs";
import { source, calibrationSource, platformSource } from "./sources.mjs";

const REQUIRED_TRAY_IDS = [
  "open-settings",
  "status-indicator",
  "tray-mode-off",
  "tray-mode-ambilight",
  "tray-mode-solid",
  "quit",
];

// LED Setup left the tabs: it is a strip's layout, opened inside Devices.
const REQUIRED_SECTION_IDS = [
  "lights",
  "devices",
  "system",
  "room-map",
];

const REQUIRED_STATE_FIELDS = [
  "schemaVersion",
  // Corner+size geometry replaced by mode-invariant center.
  // Bumped `SHELL_STATE_SCHEMA_VERSION` to 3; the 2 → 3 migration shim in
  // `features/persistence/migrations.ts` derives the center from legacy fields
  // and strips them.
  "windowCenterX",
  "windowCenterY",
  "lastSection",
  "trayHintShown",
  "roomMap",
];

/**
 * The v1.4 ShellState additions. All optional / additive — strict
 * presence check but no default-value check because each has its own
 * backend-provided default.
 */
const REQUIRED_V14_STATE_FIELDS = [
  "lightingIntensityPreset",
  "colorCorrection",
  "selectedDisplayId",
];

/**
 * v1.5 ShellState additions. All optional / additive — the absence of
 * each field naturally degrades to a v1.4-compatible default
 * (`hasCompletedOnboarding=false` shows onboarding once, `updateChannel`
 * absent ⇒ stable channel on a stable build, `selectedChipType` absent ⇒ WS2812B GRB).
 * Strict optional-`?:` presence check, no default-value check.
 */
const REQUIRED_V15_STATE_FIELDS = [
  "hasCompletedOnboarding",
  "updateChannel",
  "dontWarnFirmwareProfileMismatch",
  // Stats for nerds; additive, absent ⇒ off and no telemetry poll.
  "showNerdStats",
  // Reduce motion; additive, absent ⇒ follow the OS.
  "motion",
  // Interface size in percent; additive, absent ⇒ 100.
  "uiZoom",
  // Close button; additive, absent ⇒ hide to tray.
  "closeAction",
  // OS notifications; additive, absent ⇒ on.
  "notifications",
  // Lights on launch; additive, absent ⇒ resume the saved mode.
  "launchLights",
];

/** v1.5 contract surface that must be exported alongside the new fields. */
const REQUIRED_V15_EXPORTS = [
  "UpdateChannel",
  "defaultUpdateChannel",
  "resolveUpdateChannel",
];

console.log("\n[ Tray menu IDs ]");
for (const id of REQUIRED_TRAY_IDS) {
  check(
    source.includes(`"${id}"`),
    `tray id "${id}" defined`,
    `MISSING tray id "${id}"`
  );
}

console.log("\n[ Sidebar section IDs ]");
const sectionBlock = source.match(/export const SECTION_IDS\s*=\s*\{([^}]+)\}/s);
const declaredSectionIds = sectionBlock ? [...sectionBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]) : [];
check(sectionBlock !== null, "SECTION_IDS found", "SECTION_IDS object not found");
for (const id of REQUIRED_SECTION_IDS) {
  check(
    declaredSectionIds.includes(id),
    `section id "${id}" defined`,
    `MISSING section id "${id}"`
  );
}
for (const id of declaredSectionIds) {
  check(
    REQUIRED_SECTION_IDS.includes(id),
    `section id "${id}" is one of the tabs`,
    `UNEXPECTED section id "${id}" — a new tab must be added here on purpose`
  );
}

console.log("\n[ ShellState fields ]");
for (const field of REQUIRED_STATE_FIELDS) {
  check(
    source.includes(field + ":") || source.includes(field + "?:"),
    `ShellState field "${field}" defined`,
    `MISSING ShellState field "${field}"`
  );
}

console.log("\n[ ShellState v1.4 additions ]");
for (const field of REQUIRED_V14_STATE_FIELDS) {
  check(
    source.includes(field + "?:"),
    `ShellState v1.4 field "${field}" declared optional`,
    `MISSING optional ShellState v1.4 field "${field}"`
  );
}

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

console.log("\n[ SECTION_ORDER completeness ]");
const orderMatch = source.match(/SECTION_ORDER[^=]*=\s*\[([^\]]+)\]/s);
if (orderMatch) {
  const orderBlock = orderMatch[1];
  const ID_TO_CONST = {
    "lights": "LIGHTS",
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
console.log("\n[ Shell state schema version (strips stored) ]");
for (const retired of ["startupEnabled", "notificationsEnabled", "roomMapBackgroundOpacity"]) {
  check(
    !new RegExp(`\\b${retired}\\??:`).test(source),
    `${retired} gone from ShellState`,
    `${retired} is back on ShellState — nothing reads it, and the 6 → 7 step deletes it on load`
  );
}
check(
  !/hueChannelRegionOverrides/.test(source),
  "hueChannelRegionOverrides gone from ShellState",
  "hueChannelRegionOverrides is back on ShellState — the field is retired, positions carry the intent"
);

// `sample_led_frame` was asserted here for four waves. No `#[tauri::command]`
// ever existed, so the check certified a name that resolved to nothing —
// the bidirectional command-name parity block below is what replaces it.

// ---------------------------------------------------------------------------
// Calibration contract (shared extract)
// ---------------------------------------------------------------------------

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

console.log("\n[ Notification kinds ]");
const REQUIRED_NOTIFICATION_KINDS = ["info", "warn", "error"];
for (const kind of REQUIRED_NOTIFICATION_KINDS) {
  check(
    platformSource.includes(`"${kind}"`),
    `notification kind "${kind}" defined`,
    `MISSING notification kind "${kind}"`
  );
}

console.log("\n[ Preview tray menu id (v1.6) ]");
check(
  source.includes(`"tray-show-led-preview"`),
  'TRAY_MENU_IDS.SHOW_LED_PREVIEW ("tray-show-led-preview") defined',
  'MISSING tray id "tray-show-led-preview" in shell.ts'
);

console.log("\n[ ShellState v1.6 preview additions ]");
const REQUIRED_V16_STATE_FIELDS = ["ledPreviewPopupCenterX", "ledPreviewPopupCenterY"];
// Retired with the old preview at 8 → 9; a reader of any of them is a regression.
// The migration that deletes them is the one place allowed to name them.
const RETIRED_PREVIEW_KEYS = ["ledPreviewPopupVisible", "ledTwinEnabledTest", "lastLedTestPattern", "ledPreviewHintShown"];
const retiredKeyReaders = [
  ...walkSourceFiles(resolve(ROOT, "src"), /\.tsx?$/).filter(
    (file) => !file.endsWith("/features/persistence/migrations.ts")
  ),
  ...walkRustSourceFiles(resolve(ROOT, "src-tauri/src")),
].map((file) => [file, stripComments(readFileSync(file, "utf-8"))]);
for (const field of RETIRED_PREVIEW_KEYS) {
  check(
    !source.includes(field + "?:"),
    `ShellState no longer declares the retired "${field}"`,
    `ShellState still declares "${field}", retired at schema 9`
  );
  const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const readers = retiredKeyReaders
    .filter(([, text]) => text.includes(field) || text.includes(snake))
    .map(([file]) => relative(ROOT, file));
  check(
    readers.length === 0,
    `nothing reads the retired "${field}"`,
    `the retired "${field}" is read again in: ${readers.join(", ")}`
  );
}

console.log("\n[ roomMap writers (R45) ]");
// Retired at 9 → 10: every writer bumped it and nothing read it.
check(
  !source.includes("roomMapVersion?:"),
  'ShellState no longer declares the retired "roomMapVersion"',
  'ShellState still declares "roomMapVersion", retired at schema 10'
);
{
  const readers = retiredKeyReaders
    .filter(([, text]) => text.includes("roomMapVersion") || text.includes("room_map_version"))
    .map(([file]) => relative(ROOT, file));
  check(
    readers.length === 0,
    'nothing reads the retired "roomMapVersion"',
    `the retired "roomMapVersion" is read again in: ${readers.join(", ")}`
  );
}
// Several writers share these keys; a save replaces the whole key and reverts what another writer
// stored between its read and its write. `shellStore.update` re-reads under the store's revision.
// Syntactic: a save handed a variable rather than an object literal is not seen.
const SHARED_KEYS = /\b(roomMap|hueBridgeSyncedPositions)\b/;
function saveCallArguments(text) {
  const args = [];
  for (const m of text.matchAll(/\b(?:shellStore\.save|saveShellState)\s*\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    args.push(text.slice(start, i - 1));
  }
  return args;
}
const wholeKeySavers = walkSourceFiles(resolve(ROOT, "src"), /\.tsx?$/)
  .filter((file) => !file.endsWith("/features/persistence/shellStore.ts"))
  .filter((file) => saveCallArguments(stripComments(readFileSync(file, "utf-8"))).some((arg) => SHARED_KEYS.test(arg)))
  .map((file) => relative(ROOT, file));
check(
  wholeKeySavers.length === 0,
  "roomMap and hueBridgeSyncedPositions are written only through shellStore.update",
  `a whole-key save of roomMap or hueBridgeSyncedPositions in: ${wholeKeySavers.join(", ")}`
);

for (const field of REQUIRED_V16_STATE_FIELDS) {
  check(
    source.includes(field + "?:"),
    `ShellState v1.6 field "${field}" declared optional`,
    `MISSING optional ShellState v1.6 field "${field}"`
  );
}
