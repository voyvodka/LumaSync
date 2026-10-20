import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, VERIFY_DIR, fail, note, check, readOrEmpty, walkRustSourceFiles, stripComments, harvestCodes, constMembers, checkWireUnion, stripRustTestModules } from "./lib.mjs";
import { hueSource, deviceSource, rustHealthSource, rustLocalOutputsSource, wledRustSource, captureContractSource, tsSourceFiles } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Wire unions — emitted set must EQUAL the declared union, not merely be
// contained by it. Containment let a phantom member sit in a union forever.
// ---------------------------------------------------------------------------
console.log("\n[ Wire status unions — emitted set === declared union ]");

// The registry (`local_outputs.rs`) writes the same `SerialConnectionStatus` / entry statuses.
const rustSerialProduction = stripComments(rustHealthSource + "\n" + rustLocalOutputsSource);
checkWireUnion(
  "SerialCommandStatusCode",
  [
    ...[...rustSerialProduction.matchAll(/command_status\(\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
    // Failed connects go through `failed_connect_status(&port, "CODE", ...)`.
    ...[...rustSerialProduction.matchAll(/failed_connect_status\(\s*&?\w+,\s*"([A-Z][A-Z0-9_]*)"/g)]
      .map((m) => m[1]),
    // The last `command_status` arm passes `connect_error_code(&error)`, so its
    // match arms are part of the same wire union.
    ...[...(rustSerialProduction.match(/fn connect_error_code[\s\S]*?\n\}/) ?? [""])[0]
      .matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
    // A refused admission passes `refusal.code()` the same way.
    ...[...(rustSerialProduction.match(/impl PortRefusal[\s\S]*?\n\}/) ?? [""])[0]
      .matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
  ],
  [
    ...constMembers(deviceSource, "SERIAL_PORT_LIST_STATUS"),
    ...constMembers(deviceSource, "SERIAL_CONNECT_STATUS"),
    ...constMembers(deviceSource, "SERIAL_OUTPUT_STATUS"),
    "PORT_NOT_FOUND",
    "PORT_UNSUPPORTED",
  ],
  // 12 → 13: DISCONNECTED, a registry entry let go of or replaced (`local_outputs.rs`).
  // 13 → 12: NOT_CONNECTED left with `get_serial_connection_status`, the only status that said it.
  12
);

checkWireUnion(
  "SerialDisconnectStatusCode",
  [...stripComments(rustLocalOutputsSource).matchAll(/disconnect_result\(\s*\w+,\s*"([A-Z][A-Z0-9_]*)"/g)]
    .map((m) => m[1]),
  constMembers(deviceSource, "SERIAL_DISCONNECT_STATUS"),
  3
);

checkWireUnion(
  "WledWireStatusCode",
  [...stripComments(wledRustSource).matchAll(/CommandStatus::(?:ok|new)\(\s*"([A-Z][A-Z0-9_]*)"/g)]
    .map((m) => m[1]),
  // Mirrors the `Exclude<...>` in device.ts, which this harvest cannot read:
  // SINK_NOT_STARTED is an Err(String) prefix and LIVE_LED_COUNT_MISMATCH rides
  // the mode-apply result, so neither ever lands on a WLED command status.
  constMembers(deviceSource, "WLED_STATUS").filter(
    (c) => c !== "WLED_SINK_NOT_STARTED" && c !== "WLED_LIVE_LED_COUNT_MISMATCH"
  ),
  // 14 → 16: the two `spawn_blocking` worker-death codes, added when discovery
  // and test moved off the main thread. 16 → 17: connect followed them.
  // 17 → 19: `forget_wled_device`'s OK and FAILED. 19 → 23: `browse_wled_devices`'s OK,
  // UNSUPPORTED, FAILED and worker death.
  23
);

const rustHueRuntimeSource = walkRustSourceFiles(resolve(ROOT, "src-tauri/src/commands/hue"))
  .map((f) => stripComments(stripRustTestModules(readFileSync(f, "utf-8"))))
  .join("\n");
const HUE_RUNTIME_NOT_ON_THIS_SHAPE = [
  "AUTH_INVALID_RE_PAIR_REQUIRED",
  "HUE_CHANNEL_POSITIONS_UPDATED",
  "HUE_CHANNEL_POSITIONS_FAILED",
];
checkWireUnion(
  "HueRuntimeWireStatusCode",
  [...rustHueRuntimeSource.matchAll(/status_with\(\s*[^,]+,\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
  [
    ...constMembers(hueSource, "HUE_RUNTIME_STATUS").filter(
      (c) => !HUE_RUNTIME_NOT_ON_THIS_SHAPE.includes(c)
    ),
    ...constMembers(hueSource, "HUE_SOLID_COLOR_STATUS"),
  ],
  20
);

checkWireUnion(
  "HueAreaChannelsWireStatusCode",
  [...rustHueRuntimeSource.matchAll(/area_channels_status\(\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
  [...constMembers(hueSource, "HUE_AREA_CHANNELS_STATUS"), "AUTH_INVALID_RE_PAIR_REQUIRED"],
  5
);

// The forget, light-name and identify commands each build their status through
// one constructor, so each family is harvested from it.
const hueLiteralCodes = (fn) =>
  [...rustHueRuntimeSource.matchAll(new RegExp(`${fn}\\(\\s*"([A-Z][A-Z0-9_]*)"`, "g"))].map((m) => m[1]);
checkWireUnion("HueForgetStatusCode", hueLiteralCodes("forget_status"), constMembers(hueSource, "HUE_FORGET_STATUS"), 3);
checkWireUnion(
  "HueLightNamesWireStatusCode",
  hueLiteralCodes("light_names_status"),
  [...constMembers(hueSource, "HUE_LIGHT_NAMES_STATUS"), "AUTH_INVALID_RE_PAIR_REQUIRED"],
  3
);
checkWireUnion(
  "HueIdentifyWireStatusCode",
  hueLiteralCodes("identify_status"),
  [...constMembers(hueSource, "HUE_IDENTIFY_STATUS"), "AUTH_INVALID_RE_PAIR_REQUIRED"],
  5
);

// ---------------------------------------------------------------------------
// Highest severity: a code both trees use and neither declares. Both sides
// believe they own it and neither is authoritative — how a word-swap survives.
// ---------------------------------------------------------------------------
console.log("\n[ Status codes present in BOTH trees, declared in NEITHER ]");

// Whole crate, not just `commands/`: a producer outside it would otherwise
// report as a phantom.
const rustEmitted = harvestCodes(
  walkRustSourceFiles(resolve(ROOT, "src-tauri/src"))
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
const PHANTOM_BASELINE_FILE = resolve(VERIFY_DIR, "contract-phantom-baseline.txt");
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
  check(
    contractDeclared.has(code),
    `baseline entry "${code}" is still declared in a contract`,
    `BASELINE STALE: "${code}" is no longer declared in any contract — delete its `
      + `line from contract-phantom-baseline.txt (the file may only shrink)`
  );
}
check(
  declaredWithoutProducer.filter((c) => !phantomBaseline.has(c)).length === 0,
  `no new phantoms beyond the ${phantomBaseline.size} baselined`,
  "new phantoms found (listed above)"
);

// Mirror of the phantom block. The `both trees` check needs a TS consumer, so a
// code nothing reads yet is invisible to it — that is the gap this closes.
console.log("\n[ Rust codes with no contract declaration (ratcheted) ]");
const UNDECLARED_BASELINE_FILE = resolve(VERIFY_DIR, "contract-undeclared-baseline.txt");
const undeclaredBaseline = new Set(
  readOrEmpty(UNDECLARED_BASELINE_FILE, "undeclared baseline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
);

const emittedWithoutDeclaration = [...rustEmitted]
  .filter((code) => !contractDeclared.has(code))
  .sort();

for (const code of emittedWithoutDeclaration) {
  if (undeclaredBaseline.has(code)) {
    note(`KNOWN GAP: "${code}" emitted with no contract declaration (baselined)`);
  } else {
    fail(
      `UNDECLARED PRODUCER "${code}" — Rust emits it but no contract declares it. `
        + `Declare it if the frontend may branch on it; baseline it if it only ever `
        + `rides status.details or a thrown Err string.`
    );
  }
}

// The half that makes it a ratchet: a baselined code that gains a declaration
// has been promoted to a discriminator, so its line must go.
for (const code of undeclaredBaseline) {
  check(
    !contractDeclared.has(code),
    `baseline entry "${code}" still undeclared`,
    `BASELINE STALE: "${code}" is now declared in a contract — delete its line from `
      + `contract-undeclared-baseline.txt (the file may only shrink)`
  );
}
check(
  emittedWithoutDeclaration.filter((c) => !undeclaredBaseline.has(c)).length === 0,
  `no undeclared producers beyond the ${undeclaredBaseline.size} baselined`,
  "undeclared producers found (listed above)"
);

// ---------------------------------------------------------------------------
// Ambilight capture reasons — derived Rust → capture.ts parity
// ---------------------------------------------------------------------------
// `lighting_mode.rs` is a module root; the worker under `lighting_mode/` emits reasons too.
const RUST_CAPTURE_FILES = [
  resolve(ROOT, "src-tauri/src/commands/ambilight_capture.rs"),
  resolve(ROOT, "src-tauri/src/commands/lighting_mode.rs"),
  ...walkRustSourceFiles(resolve(ROOT, "src-tauri/src/commands/lighting_mode")),
];

console.log("\n[ Ambilight capture reasons — Rust → capture.ts parity ]");
const emittedCaptureReasons = [
  ...new Set(
    RUST_CAPTURE_FILES.flatMap((file) => {
      const source = readOrEmpty(file, `rust ${file}`);
      // These ride `status.details`, never a status code, so `undeclaredInBoth`
      // is structurally blind to them and this loop is the only guard.
      // Quoted only: `AMBILIGHT_CAPTURE_ATTEMPTS` is a counter, not a reason.
      const production = stripRustTestModules(source);
      return [...production.matchAll(/"(AMBILIGHT_CAPTURE_[A-Z0-9_]+)"/g)].map((m) => m[1]);
    })
  ),
].sort();

// Pinned, not `> 0`: hoisting a reason into a `const` would hide it from this
// harvest while the rest still matched. Bump deliberately when one is added.
const EXPECTED_CAPTURE_REASON_COUNT = 18;
check(
  emittedCaptureReasons.length === EXPECTED_CAPTURE_REASON_COUNT,
  `harvested exactly ${EXPECTED_CAPTURE_REASON_COUNT} capture reasons from the Rust tree`,
  `HARVEST COUNT DRIFT: expected ${EXPECTED_CAPTURE_REASON_COUNT} capture reasons, got `
    + `${emittedCaptureReasons.length} [${emittedCaptureReasons.join(", ")}] — a reason was added, `
    + `removed, or refactored out of a string literal (which this harvest cannot see)`
);
for (const reason of emittedCaptureReasons) {
  check(
    captureContractSource.includes(`"${reason}"`),
    `capture reason "${reason}" declared in capture.ts`,
    `UNDECLARED capture reason "${reason}" — Rust emits it into status.details but `
      + `capture.ts > AMBILIGHT_CAPTURE_REASON does not declare it, so `
      + `classifyCaptureFailure() silently buckets it as "internal"`
  );
}

// The non-capture tenant of the same field. Derived, not a single hardcoded
// check: LedOutputError::as_reason() puts every one of these into status.details.
console.log("\n[ LED output reasons — Rust → capture.ts parity ]");
const LED_OUTPUT_RUST_FILE = resolve(ROOT, "src-tauri/src/commands/led_output/serial.rs");
const emittedLedOutputReasons = [
  ...new Set(
    [
      ...stripComments(stripRustTestModules(readOrEmpty(LED_OUTPUT_RUST_FILE, "rust led_output")))
        .matchAll(/"(LED_OUTPUT_[A-Z0-9_]+)"/g),
    ].map((m) => m[1])
  ),
].sort();
// 7 → 6: LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED went with the test-only helper that produced it.
const EXPECTED_LED_OUTPUT_REASON_COUNT = 6;
check(
  emittedLedOutputReasons.length === EXPECTED_LED_OUTPUT_REASON_COUNT,
  `harvested exactly ${EXPECTED_LED_OUTPUT_REASON_COUNT} LED output reasons from led_output/serial.rs`,
  `HARVEST COUNT DRIFT: expected ${EXPECTED_LED_OUTPUT_REASON_COUNT}, got `
    + `${emittedLedOutputReasons.length} [${emittedLedOutputReasons.join(", ")}] — update the pin deliberately`
);
for (const reason of emittedLedOutputReasons) {
  check(
    captureContractSource.includes(`"${reason}"`),
    `LED output reason "${reason}" declared in capture.ts`,
    `UNDECLARED LED output reason "${reason}" — lighting_mode.rs puts it in the same `
      + `status.details field as the capture reasons, so classifyCaptureFailure() `
      + `silently buckets it as "internal"`
  );
}
