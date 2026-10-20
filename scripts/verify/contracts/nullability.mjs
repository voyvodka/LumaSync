import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, VERIFY_DIR, fail, check, readOrEmpty, walkRustSourceFiles } from "./lib.mjs";
import { contractModuleFiles } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Nullability parity — Rust field shape ↔ TS optionality.
//
// The blocks above assert a field is *declared*, never with what cardinality —
// which is how every `details?: string` stayed wrong about a wire that sends
// `"details": null`. Three rules:
//   1. `Option<T>` without `skip_serializing_if` ⇒ TS type must admit `null`.
//   2. `Option<T>` with `skip_serializing_if`    ⇒ TS field must be optional.
//   3. non-`Option` ⇒ TS field must NOT be optional, unless
//      `#[serde(default)]` licenses the sender to omit it.
// ---------------------------------------------------------------------------
console.log("\n[ Nullability parity — Rust Option ↔ TS null/optional ]");

/**
 * Rust struct name → TS interface name, for the pairs whose names differ.
 * Everything else is matched by identical name.
 */
const NULLABILITY_NAME_ALIASES = {
  HueEntertainmentArea: "HueEntertainmentAreaSummary",
  // `commands/status.rs` — the one Rust envelope, pinned single below.
  CommandStatus: "CommandStatusOf",
  DisplayInfoPayload: "DisplayInfo",
  // Serialised into the calibration overlay window, not returned by a command.
  OverlayPreviewCountsPayload: "OverlayPreviewCounts",
  OverlayPreviewSequenceItemPayload: "OverlayPreviewSequenceItem",
};

/**
 * Same-name pairs deliberately NOT checked, each with the reason. The coverage
 * pin below forces a new pair into one list or the other, so this cannot become
 * a silent dumping ground.
 */
// Emptied when the `save_room_map` stub took its four unread Rust mirrors with
// it. A pair belongs here only if its struct truly never reaches a frontend.
const NULLABILITY_EXCLUDED_PAIRS = {};

/** Split a Rust struct body into `{ name, ty, attrs }`, attributes attached. */
function rustFieldsWithAttrs(body) {
  const fields = [];
  let attrs = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("///") || line.startsWith("//") || line.length === 0) continue;
    if (line.startsWith("#[")) {
      attrs += line;
      continue;
    }
    const m = line.match(/^pub\s+([a-z0-9_]+)\s*:\s*(.+?),?$/);
    if (m) {
      fields.push({
        name: m[1].replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()),
        ty: m[2],
        attrs,
      });
    }
    attrs = "";
  }
  return fields;
}

/** Collect every Serialize-deriving `pub struct` across the Rust tree. */
const rustSerializableStructs = new Map();
for (const file of walkRustSourceFiles(resolve(ROOT, "src-tauri/src"))) {
  const src = readFileSync(file, "utf-8");
  for (const m of src.matchAll(
    /((?:#\[[^\]]*\]\s*)+)pub struct (\w+)\s*\{([\s\S]*?)\n\}/g
  )) {
    if (!/derive\([^)]*\bSerialize\b/.test(m[1])) continue;
    // A duplicate name is kept, not overwritten, so every definition is
    // checked against the interface it mirrors.
    const existing = rustSerializableStructs.get(m[2]) ?? [];
    existing.push({ file, fields: rustFieldsWithAttrs(m[3]) });
    rustSerializableStructs.set(m[2], existing);
  }
}

/** Contract interfaces, with `extends` parents resolved for field lookup. */
const contractInterfaces = new Map();
for (const file of contractModuleFiles) {
  const src = readFileSync(file, "utf-8");
  for (const m of src.matchAll(
    /export interface (\w+)(?:<[^>]*>)?(?:\s+extends\s+([\w,\s<>]+?))?\s*\{([\s\S]*?)\n\}/g
  )) {
    contractInterfaces.set(m[1], {
      file: file.split("/").pop(),
      parents: (m[2] ?? "")
        .split(",")
        .map((p) => p.trim().replace(/<.*>$/, ""))
        .filter(Boolean),
      body: m[3],
    });
  }
}

/** Find a field on an interface or any of its `extends` parents. */
function lookupTsField(interfaceName, field, seen = new Set()) {
  if (seen.has(interfaceName)) return null;
  seen.add(interfaceName);
  const iface = contractInterfaces.get(interfaceName);
  if (!iface) return null;
  const m = iface.body.match(
    new RegExp(`^\\s*${field}(\\??)\\s*:\\s*([^;\\n]+)`, "m")
  );
  if (m) return { optional: m[1] === "?", ty: m[2].trim() };
  for (const parent of iface.parents) {
    const inherited = lookupTsField(parent, field, seen);
    if (inherited) return inherited;
  }
  return null;
}

const nullabilityPairs = [];
const unpairedStructs = [];
for (const [structName, defs] of rustSerializableStructs) {
  const tsName = NULLABILITY_NAME_ALIASES[structName] ?? structName;
  // Was a bare `continue`: an unpaired struct was not excluded, it was
  // INVISIBLE — absent from the pair list, the coverage pin and the exclusion
  // table alike. That hid 30 of 70 wire structs, including a live mismatch.
  if (!contractInterfaces.has(tsName)) {
    unpairedStructs.push(structName);
    continue;
  }
  nullabilityPairs.push({ structName, tsName, defs });
}

console.log("\n[ One coded-status envelope in Rust ]");
// Four structs used to carry `{ code, message, details }` under three names;
// a fifth would drift on its own derives. Any Serialize struct whose fields are
// exactly that trio must be the one `CommandStatus` in commands/status.rs.
{
  const ENVELOPE_FIELDS = ["code", "details", "message"].join(",");
  const envelopeCopies = [];
  for (const [structName, defs] of rustSerializableStructs) {
    for (const def of defs) {
      const names = def.fields.map((f) => f.name).sort().join(",");
      if (names === ENVELOPE_FIELDS) envelopeCopies.push({ structName, file: def.file });
    }
  }
  const canonical = envelopeCopies.filter(
    (c) => c.structName === "CommandStatus" && c.file.endsWith("/commands/status.rs")
  );
  check(
    canonical.length === 1 && envelopeCopies.length === 1,
    "exactly one Rust coded-status struct (commands/status.rs CommandStatus)",
    `DUPLICATE ENVELOPE: ${envelopeCopies
      .map((c) => `${c.structName} (${c.file.replace(`${ROOT}/`, "")})`)
      .join(", ")} — use commands::status::CommandStatus instead of a local copy`
  );
}

console.log("\n[ Serialize structs with no contract interface (ratcheted) ]");
const UNPAIRED_BASELINE_FILE = resolve(VERIFY_DIR, "contract-unpaired-struct-baseline.txt");
const unpairedBaseline = new Set(
  readOrEmpty(UNPAIRED_BASELINE_FILE, "unpaired-struct baseline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
);
for (const structName of unpairedStructs.filter((n) => !unpairedBaseline.has(n)).sort()) {
  fail(
    `UNPAIRED WIRE STRUCT "${structName}" — it derives Serialize but no `
      + `interface in src/shared/contracts/ carries its name, so none of its `
      + `fields are nullability-checked. Add a NULLABILITY_NAME_ALIASES entry `
      + `if the mirror exists under another name, move the mirror into a `
      + `contract, or baseline it with the reason.`
  );
}
check(
  unpairedStructs.filter((n) => !unpairedBaseline.has(n)).length === 0,
  `no new unpaired wire structs beyond the ${unpairedBaseline.size} baselined`,
  "new unpaired wire structs found (listed above)"
);
for (const structName of unpairedBaseline) {
  check(
    unpairedStructs.includes(structName),
    `baseline entry "${structName}" is still unpaired`,
    `STALE BASELINE: "${structName}" now pairs with a contract interface — `
      + `delete the line from contract-unpaired-struct-baseline.txt (it may only shrink)`
  );
}

// Coverage pin. A new Serialize struct that shares a contract interface name
// lands here automatically; a deliberate exclusion needs a line above.
const checkedPairs = nullabilityPairs.filter(
  (p) => !(p.structName in NULLABILITY_EXCLUDED_PAIRS)
);
// Pinned so the harvest cannot narrow silently; the change that moves it says why.
const EXPECTED_NULLABILITY_PAIR_COUNT = 95;
check(
  nullabilityPairs.length === EXPECTED_NULLABILITY_PAIR_COUNT,
  `harvested exactly ${EXPECTED_NULLABILITY_PAIR_COUNT} Rust↔contract struct pairs`,
  `PAIR COUNT DRIFT: expected ${EXPECTED_NULLABILITY_PAIR_COUNT} Rust↔contract `
    + `pairs, found ${nullabilityPairs.length} `
    + `[${nullabilityPairs.map((p) => p.structName).join(", ")}] — a new wire `
    + `struct appeared or one vanished; update the pin deliberately`
);
for (const structName of Object.keys(NULLABILITY_EXCLUDED_PAIRS)) {
  check(
    nullabilityPairs.some((p) => p.structName === structName),
    `exclusion "${structName}" still names a real pair`,
    `STALE EXCLUSION: "${structName}" is in NULLABILITY_EXCLUDED_PAIRS but no `
      + `longer pairs a Serialize struct with a contract interface — drop the line`
  );
}

let nullabilityViolations = 0;
for (const { structName, tsName, defs } of checkedPairs) {
  for (const { file, fields } of defs) {
    const where = file.slice(file.indexOf("src-tauri/"));
    for (const { name, ty, attrs } of fields) {
      const ts = lookupTsField(tsName, name);
      if (!ts) continue; // field-presence is the existing blocks' job
      const isOption = /^Option</.test(ty);
      const skips = /skip_serializing_if/.test(attrs);
      const hasDefault = /\bdefault\b/.test(attrs);
      const admitsNull = /\bnull\b/.test(ts.ty);

      if (isOption && !skips && !admitsNull) {
        nullabilityViolations++;
        fail(
          `NULLABILITY DRIFT: ${structName}.${name} is \`${ty}\` with no `
            + `\`skip_serializing_if\` (${where}), so it is on the wire as `
            + `\`null\` — but ${tsName}.${name} is declared \`${ts.optional ? "?:" : ":"} `
            + `${ts.ty}\`. Widen it to \`| null\`.`
        );
      } else if (isOption && skips && !ts.optional) {
        nullabilityViolations++;
        fail(
          `NULLABILITY DRIFT: ${structName}.${name} is skipped when \`None\` `
            + `(${where}), so the key can be absent — but ${tsName}.${name} is `
            + `declared required. Mark it \`?:\`.`
        );
      } else if (!isOption && !hasDefault && ts.optional) {
        nullabilityViolations++;
        fail(
          `NULLABILITY DRIFT: ${structName}.${name} is \`${ty}\` — never `
            + `\`Option\`, no \`#[serde(default)]\` (${where}) — so it is always `
            + `on the wire, but ${tsName}.${name} is declared optional. Drop the \`?\`.`
        );
      }
    }
  }
}
check(
  nullabilityViolations === 0,
  `no Option/null drift across ${checkedPairs.length} checked struct pairs`,
  `${nullabilityViolations} nullability mismatches (listed above)`
);
