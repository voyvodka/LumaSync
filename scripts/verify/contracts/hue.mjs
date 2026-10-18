import { resolve } from "node:path";

import { ROOT, fail, check, readOrEmpty, stripComments, rustStructFields, stripRustTestModules } from "./lib.mjs";
import { hueSource } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Hue contract
// ---------------------------------------------------------------------------

console.log("\n[ Hue intensity preset ]");
check(
  hueSource.includes("HUE_INTENSITY_PRESET_COEFFICIENTS"),
  "HUE_INTENSITY_PRESET_COEFFICIENTS map exported",
  "MISSING HUE_INTENSITY_PRESET_COEFFICIENTS"
);

console.log("\n[ Hue zone re-export surface (v1.5 W4-F2) ]");
// Zones are Hue-only, so hue.ts re-exports the canonical Hue zone
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

console.log("\n[ Hue pairing response — Rust → hue.ts field parity ]");
// credentialStorageBackend was dropped here once already and the DTLS
// pre-shared key stayed in plaintext as a result — docs/architecture/hue.md.
const HUE_ONBOARDING_RUST_FILE = resolve(
  ROOT,
  "src-tauri/src/commands/hue_onboarding/pairing.rs"
);
const hueOnboardingRustSource = readOrEmpty(HUE_ONBOARDING_RUST_FILE, "rust hue_onboarding");
const HUE_CREDENTIAL_STORE_RUST_FILE = resolve(
  ROOT,
  "src-tauri/src/commands/hue/credential_store.rs"
);
const credentialStoreRustSource = readOrEmpty(
  HUE_CREDENTIAL_STORE_RUST_FILE,
  "rust credential_store"
);

const EXPECTED_PAIR_RESPONSE_FIELDS = 3;
const pairResponseFields = rustStructFields(hueOnboardingRustSource, "HuePairBridgeResponse");
if (!pairResponseFields || pairResponseFields.length === 0) {
  fail('EXTRACTION FAILED: no fields found on Rust struct "HuePairBridgeResponse"');
} else {
  check(
    pairResponseFields.length === EXPECTED_PAIR_RESPONSE_FIELDS,
    `HuePairBridgeResponse harvested exactly ${EXPECTED_PAIR_RESPONSE_FIELDS} fields`,
    `HARVEST COUNT DRIFT: expected ${EXPECTED_PAIR_RESPONSE_FIELDS} fields on `
      + `HuePairBridgeResponse, got ${pairResponseFields.length} `
      + `[${pairResponseFields.join(", ")}] — update the pin deliberately`
  );
  const tsPairBlock = hueSource.match(
    /export interface HuePairBridgeResponse\s*\{([\s\S]*?)\n\}/
  );
  if (!tsPairBlock) {
    fail('MISSING interface "HuePairBridgeResponse" in hue.ts');
  } else {
    for (const field of pairResponseFields) {
      check(
        new RegExp(`^\\s*${field}\\??\\s*:`, "m").test(tsPairBlock[1]),
        `HuePairBridgeResponse.${field} declared in hue.ts`,
        `MISSING HuePairBridgeResponse.${field} in hue.ts — Rust serializes it `
          + `(#[serde(rename_all = "camelCase")]) but the contract drops it`
      );
    }
  }
}

// The backend strings are a wire contract shared by two files; if they drift,
// "keychain" stops being recognised and the plaintext copy is kept forever.
// The wire enum is `HueCredentialBackend`, not the internal `CredentialBackend`,
// whose `Noop` can never report a pair as persisted and so has no wire value.
const rustWireBackendBlock = credentialStoreRustSource.match(
  /pub enum HueCredentialBackend\s*\{([\s\S]*?)\n\}/
);
const rustWireBackends = rustWireBackendBlock
  ? [...rustWireBackendBlock[1].matchAll(/#\[serde\(rename = "([a-z-]+)"\)\]/g)].map((m) => m[1]).sort()
  : [];
const tsBackendBlock = hueSource.match(/export const HUE_CREDENTIAL_BACKENDS = \{([\s\S]*?)\}/);
const tsBackends = tsBackendBlock
  ? [...tsBackendBlock[1].matchAll(/:\s*"([a-z-]+)"/g)].map((m) => m[1]).sort()
  : [];
check(
  rustWireBackends.length > 0
    && rustWireBackends.includes("keychain")
    && JSON.stringify(rustWireBackends) === JSON.stringify(tsBackends),
  `HUE_CREDENTIAL_BACKENDS equals Rust's wire HueCredentialBackend [${rustWireBackends.join(", ")}]`,
  "BACKEND LITERAL DRIFT: Rust HueCredentialBackend "
    + `[${rustWireBackends.join(", ")}] vs hue.ts HUE_CREDENTIAL_BACKENDS [${tsBackends.join(", ")}]`
);

// Same shape again for the Hue DTLS/entertainment transport detail.
console.log("\n[ Hue transport reasons — Rust → hue.ts parity ]");
const HUE_TRANSPORT_RUST_FILES = [
  resolve(ROOT, "src-tauri/src/commands/hue/dtls.rs"),
  resolve(ROOT, "src-tauri/src/commands/hue/sender/entertainment.rs"),
  resolve(ROOT, "src-tauri/src/commands/hue/sender/dtls_loop.rs"),
  resolve(ROOT, "src-tauri/src/commands/hue/sender/builder.rs"),
];
const emittedHueTransportReasons = [
  ...new Set(
    HUE_TRANSPORT_RUST_FILES.flatMap((file) =>
      [
        ...stripComments(stripRustTestModules(readOrEmpty(file, `rust ${file}`)))
          // `"CODE: detail"` counts: these are format! prefixes, not bare literals.
          .matchAll(/"((?:DTLS|ENTERTAINMENT|HUE_SENDER)_[A-Z0-9_]+)(?:"|:\s)/g),
      ].map((m) => m[1])
    )
  ),
].sort();
const EXPECTED_HUE_TRANSPORT_REASON_COUNT = 13;
check(
  emittedHueTransportReasons.length === EXPECTED_HUE_TRANSPORT_REASON_COUNT,
  `harvested exactly ${EXPECTED_HUE_TRANSPORT_REASON_COUNT} Hue transport reasons`,
  `HARVEST COUNT DRIFT: expected ${EXPECTED_HUE_TRANSPORT_REASON_COUNT}, got `
    + `${emittedHueTransportReasons.length} [${emittedHueTransportReasons.join(", ")}] — update the pin deliberately`
);
for (const reason of emittedHueTransportReasons) {
  check(
    hueSource.includes(`"${reason}"`),
    `Hue transport reason "${reason}" declared in hue.ts`,
    `UNDECLARED Hue transport reason "${reason}" — it rides status.details on a `
      + `HUE_STREAM_* status but hue.ts > HUE_TRANSPORT_REASON does not name it`
  );
}

// `simulate_hue_fault` is allowlisted as uncontracted above, so no code check
// reaches it — this is the only guard against a relapse to `Err(String)`.
console.log("\n[ Debug-only Hue command — never-throw return shape ]");
const hueCommandsRustSource = stripComments(
  readOrEmpty(resolve(ROOT, "src-tauri/src/commands/hue/commands.rs"), "rust hue/commands")
);
const simulateReturnTypes = [
  ...hueCommandsRustSource.matchAll(
    /pub fn simulate_hue_fault\s*\([\s\S]*?\)\s*->\s*([^{]+?)\s*\{/g
  ),
].map((m) => m[1].trim());
check(
  simulateReturnTypes.length === 2,
  "harvested both simulate_hue_fault arms (debug + release stub)",
  `HARVEST DRIFT: expected 2 simulate_hue_fault signatures, got `
    + `${simulateReturnTypes.length} — the cfg-gated pair changed shape`
);
for (const returnType of simulateReturnTypes) {
  check(
    returnType === "CommandStatus",
    `simulate_hue_fault arm returns CommandStatus`,
    `NEVER-THROW VIOLATION: a simulate_hue_fault arm returns "${returnType}" — its `
      + `HUE_DEBUG_COMMAND_CODES would reach the caller as a rejected promise `
      + `instead of a code to branch on`
  );
}
