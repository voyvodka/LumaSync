import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, fail, check, readOrEmpty, rustStructFields } from "./lib.mjs";
import { hueSource, telemetrySource, rustTelemetrySource } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Runtime telemetry — derived Rust → TS field parity
// ---------------------------------------------------------------------------

console.log("\n[ Runtime telemetry — Rust → telemetry.ts field parity ]");
// Same degradation shape as the lighting harvest: a removed Rust field silently
// stops being checked. Pin the count so the loop cannot quietly narrow.
const EXPECTED_TELEMETRY_FIELD_COUNTS = {
  // + lastOutputErrorCode, lastOutputErrorAtSecs, workerStopped: a failing send and a stopped worker.
  RuntimeTelemetrySnapshot: 12,
  HueTelemetrySnapshot: 11,
  FullTelemetrySnapshot: 2,
  // + outputFailureCode, workerStopped.
  RuntimeHealth: 5,
  CaptureFpsSample: 3,
  RuntimeTelemetryHistory: 1,
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
const rustLinkThreshold = readOrEmpty(
  resolve(ROOT, "src-tauri/src/commands/lighting_mode/pacing.rs"),
  "rust pacing"
).match(
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

// A drifted "failing now" window would silence the stall notice quietly. The event name itself is
// `verify:event-names`'s to pin.
console.log("\n[ Runtime health push — Rust ↔ telemetry.ts parity ]");
const rustOngoingAge = rustTelemetrySource.match(
  /CAPTURE_FAILURE_ONGOING_MAX_AGE_SECS:\s*u64\s*=\s*([0-9]+)/
);
const tsOngoingAge = telemetrySource.match(/CAPTURE_FAILURE_ONGOING_MAX_AGE_SECS\s*=\s*([0-9]+)/);
check(
  rustOngoingAge !== null && tsOngoingAge !== null && rustOngoingAge[1] === tsOngoingAge[1],
  `CAPTURE_FAILURE_ONGOING_MAX_AGE_SECS matches (${rustOngoingAge ? rustOngoingAge[1] : "?"})`,
  `THRESHOLD DRIFT: Rust CAPTURE_FAILURE_ONGOING_MAX_AGE_SECS=${rustOngoingAge ? rustOngoingAge[1] : "?"} `
    + `vs telemetry.ts ${tsOngoingAge ? tsOngoingAge[1] : "?"}`
);

// How long an identified Hue light blinks: the button holds its label for as long.
const rustIdentifySignal = readFileSync(resolve(ROOT, "src-tauri/src/commands/hue/lights.rs"), "utf8").match(
  /HUE_IDENTIFY_SIGNAL_MS:\s*u64\s*=\s*([0-9_]+)/
);
const tsIdentifySignal = hueSource.match(/HUE_IDENTIFY_SIGNAL_MS\s*=\s*([0-9_]+)/);
check(
  rustIdentifySignal !== null && tsIdentifySignal !== null && rustIdentifySignal[1] === tsIdentifySignal[1],
  `HUE_IDENTIFY_SIGNAL_MS matches (${rustIdentifySignal ? rustIdentifySignal[1] : "?"})`,
  `DRIFT: Rust HUE_IDENTIFY_SIGNAL_MS=${rustIdentifySignal ? rustIdentifySignal[1] : "?"} `
    + `vs hue.ts ${tsIdentifySignal ? tsIdentifySignal[1] : "?"}`
);
