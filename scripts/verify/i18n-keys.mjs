#!/usr/bin/env node
// i18n key verifier: scans every string literal in src/** (not just t() calls
// — some keys are read as bare data) for missing keys (fatal) and orphans (ratcheted).

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const EN_CATALOGUE_FILE = resolve(ROOT, "src/locales/en/common.json");
const SRC_DIR = resolve(ROOT, "src");
const LOCALES_DIR = resolve(ROOT, "src/locales");
const ORPHAN_BASELINE_FILE = resolve(__dirname, "i18n-orphan-baseline.txt");
const NAMESPACE_REGISTRY_FILE = resolve(ROOT, "src/features/i18n/namespaces.ts");

// ---------------------------------------------------------------------------
// Known dynamic template-literal heads. Each maps to a live `` t(`prefix.${x}`) ``
// site; verified against source at design time (D-DESIGN.md "Dynamic prefixes").
// A head found in source but not in this list is reported via note() — not a
// failure, since it's not necessarily wrong, but it means this list has drifted
// from the code and orphan accounting under that prefix is no longer reliable.
// ---------------------------------------------------------------------------
const KNOWN_DYNAMIC_PREFIXES = [
  "device.healthCheck.steps.labels",
  "device.hue.channelMap.regions",
  "device.hue.runtime.codes",
  "device.hue.runtime.states",
  "device.hue.runtime.triggerSource",
  "hotplug.targetLabel",
  "ledPreview.pattern",
  "ledPreview.status",
  "ledPreview.test.speed",
  "roomMap.furniture.type",
  "settings.sections",
  "telemetry.queueHealth",
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

function note(msg) {
  console.log(`  •  ${msg}`);
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
    console.error(`\nWARN: Cannot read ${label}: ${path}`);
    return "";
  }
}

/** Flatten a nested JSON catalogue into dot-path leaf keys. */
function flattenCatalogue(obj, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenCatalogue(value, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function walkSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (full === LOCALES_DIR) continue;
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // and /* *\/ comments so comment-only key mentions don't count as references. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

// A key segment: letters, digits, `_`/`-` (covers SCREAMING_SNAKE_CASE status
// codes and kebab-case section ids like "led-setup"), must start with a letter.
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/;

/**
 * Extract candidate key-literal strings from a source file: every quoted or
 * template string, plus the static head of every template literal (the part
 * before the first `${`, trailing dot stripped).
 */
function extractLiterals(source) {
  const literals = [];
  const templateHeads = [];
  const stringRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = stringRe.exec(source)) !== null) {
    const raw = m[0];
    const quote = raw[0];
    const inner = raw.slice(1, -1);
    if (quote === "`") {
      const dollarIdx = inner.indexOf("${");
      if (dollarIdx === -1) {
        literals.push(inner);
      } else {
        const head = inner.slice(0, dollarIdx).replace(/\.$/, "");
        if (head.length > 0) templateHeads.push(head);
      }
    } else {
      literals.push(inner);
    }
  }
  return { literals, templateHeads };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("\ni18n Key Reference Verifier");
console.log("============================");

let enCatalogue;
try {
  enCatalogue = JSON.parse(readFileSync(EN_CATALOGUE_FILE, "utf-8"));
  console.log(`\nCatalogue: ${EN_CATALOGUE_FILE}`);
} catch (err) {
  console.error(`\nFATAL: Cannot read/parse EN catalogue: ${EN_CATALOGUE_FILE}`);
  console.error(err.message);
  process.exit(1);
}

const catalogueKeys = flattenCatalogue(enCatalogue);
const catalogueKeySet = new Set(catalogueKeys);
const topLevelPrefixes = new Set(Object.keys(enCatalogue));

// i18next plural forms: t("x.y") resolves to "x.y_one"/"x.y_other" at runtime
// (zoneChannelCount is the one live case) — the base key never appears as a leaf.
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];
const pluralBaseKeys = new Set(
  catalogueKeys
    .filter((key) => PLURAL_SUFFIXES.some((suffix) => key.endsWith(suffix)))
    .map((key) => key.replace(/_(zero|one|two|few|many|other)$/, ""))
);

console.log(`Catalogue leaf keys: ${catalogueKeys.length}`);

const sourceFiles = walkSourceFiles(SRC_DIR);
console.log(`Source files scanned: ${sourceFiles.length}`);

const referenced = new Set();
const missingCandidates = new Map(); // key literal -> first file:line seen
const unhandledDynamicHeads = new Set();

for (const file of sourceFiles) {
  const raw = readFileSync(file, "utf-8");
  const source = stripComments(raw);
  const relPath = file.slice(ROOT.length + 1);
  const { literals, templateHeads } = extractLiterals(source);

  for (const lit of literals) {
    if (!KEY_SHAPE.test(lit)) continue;
    const topSegment = lit.slice(0, lit.indexOf("."));
    if (!topLevelPrefixes.has(topSegment)) continue;

    if (catalogueKeySet.has(lit)) {
      referenced.add(lit);
    } else if (pluralBaseKeys.has(lit)) {
      for (const suffix of PLURAL_SUFFIXES) referenced.add(lit + suffix);
    } else if (!missingCandidates.has(lit)) {
      const lineNo = raw.slice(0, raw.indexOf(lit)).split("\n").length;
      missingCandidates.set(lit, `${relPath}:${lineNo}`);
    }
  }

  for (const head of templateHeads) {
    if (!KEY_SHAPE.test(head) && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(head)) continue;
    const topSegment = head.split(".")[0];
    if (!topLevelPrefixes.has(topSegment)) continue;

    if (KNOWN_DYNAMIC_PREFIXES.includes(head)) {
      const subtreePrefix = `${head}.`;
      for (const key of catalogueKeys) {
        if (key.startsWith(subtreePrefix)) referenced.add(key);
      }
    } else {
      unhandledDynamicHeads.add(`${head} (${relPath})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Missing (FATAL)
// ---------------------------------------------------------------------------
console.log("\n[ Missing catalogue keys ]");
if (missingCandidates.size === 0) {
  pass("no source reference points at a non-existent catalogue key");
} else {
  for (const [key, loc] of missingCandidates) {
    fail(`MISSING catalogue key "${key}" referenced at ${loc}`);
  }
}

if (unhandledDynamicHeads.size > 0) {
  console.log("\n[ Unrecognized dynamic template heads (informational) ]");
  for (const entry of unhandledDynamicHeads) {
    note(
      `template head not in KNOWN_DYNAMIC_PREFIXES: ${entry} — its subtree's `
        + `orphan status may be unreliable until this list is updated`
    );
  }
}

// ---------------------------------------------------------------------------
// Orphans (RATCHETED, not fatal)
// ---------------------------------------------------------------------------
console.log("\n[ Orphan catalogue keys (ratcheted) ]");
const orphans = catalogueKeys.filter((key) => !referenced.has(key)).sort();
const orphanBaseline = new Set(
  readOrEmpty(ORPHAN_BASELINE_FILE, "orphan baseline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
);

const newOrphans = orphans.filter((key) => !orphanBaseline.has(key));
const staleBaselineEntries = [...orphanBaseline].filter((key) => !orphans.includes(key)).sort();

for (const key of newOrphans) {
  fail(`NEW ORPHAN "${key}" — referenced nowhere and not in the baseline`);
}
check(
  newOrphans.length === 0,
  `no new orphans beyond the ${orphanBaseline.size} baselined`,
  "new orphans found (listed above)"
);
note(`${orphans.length} total orphan keys (${orphanBaseline.size} baselined)`);
for (const key of staleBaselineEntries) {
  note(`baseline entry "${key}" is now referenced — safe to prune from i18n-orphan-baseline.txt`);
}

// ---------------------------------------------------------------------------
// Registry integrity — no-op until the namespace split (D2) exists.
// ---------------------------------------------------------------------------
console.log("\n[ Namespace registry integrity ]");
if (existsSync(NAMESPACE_REGISTRY_FILE)) {
  // D2 activates this: verify every registered namespace has matching EN/TR
  // barrel exports and every ns:key reference resolves within its namespace.
  // Not implemented here — D1 only detects the registry's arrival.
  fail(
    "namespaces.ts now exists but registry-integrity checking is not implemented "
      + "— wire it up as part of D2 before merging the namespace split"
  );
} else {
  note("skipped — flat common.json catalogue, no namespace registry yet (activates in D2)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n============================`);
if (errors === 0) {
  console.log(`✔  All ${checks} checks passed — i18n keys verified.\n`);
  process.exit(0);
} else {
  console.error(`✘  ${errors} of ${checks} checks FAILED — i18n key drift detected.\n`);
  process.exit(1);
}
