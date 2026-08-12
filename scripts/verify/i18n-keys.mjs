#!/usr/bin/env node
// i18n key verifier: scans every string literal in src/** (not just t() calls
// — some keys are read as bare data) for missing keys (fatal) and orphans (ratcheted),
// and checks the namespace registry against the EN/TR locale barrels.

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const SRC_DIR = resolve(ROOT, "src");
const LOCALES_DIR = resolve(ROOT, "src/locales");
const ORPHAN_BASELINE_FILE = resolve(__dirname, "i18n-orphan-baseline.txt");
const NAMESPACE_REGISTRY_FILE = resolve(ROOT, "src/features/i18n/namespaces.ts");

// The flat pre-split catalogue. Present only while the namespace migration is in
// flight; keys still living here are addressed with bare (unqualified) literals.
const LEGACY_NS = "legacy";
const LEGACY_CATALOGUE_FILE = resolve(ROOT, "src/locales/en/common.json");

// Static heads of live `` t(`prefix.${x}`) `` sites. An unlisted head is only a
// note(), but orphan accounting under it is unreliable until the list catches up.
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
  "telemetry:queueHealth",
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

/** Flatten a nested catalogue object into dot-path leaf keys. */
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
const SEGMENT = "[A-Za-z][A-Za-z0-9_-]*";
const DOTTED_KEY = new RegExp(`^${SEGMENT}(\\.${SEGMENT})+$`);
const QUALIFIED_KEY = new RegExp(`^(${SEGMENT}):(${SEGMENT}(\\.${SEGMENT})*)$`);
const SINGLE_KEBAB_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*(-[A-Za-z0-9_]+)+$/;

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
// Catalogue: one flat key set per registered namespace
// ---------------------------------------------------------------------------
console.log("\ni18n Key Reference Verifier");
console.log("============================");

if (!existsSync(NAMESPACE_REGISTRY_FILE)) {
  console.error(`\nFATAL: namespace registry missing: ${NAMESPACE_REGISTRY_FILE}`);
  process.exit(1);
}

const { I18N_NAMESPACES, I18N_DEFAULT_NS } = await import(
  pathToFileURL(NAMESPACE_REGISTRY_FILE).href
);

async function loadNamespace(ns) {
  if (ns === LEGACY_NS) {
    return JSON.parse(readFileSync(LEGACY_CATALOGUE_FILE, "utf-8"));
  }
  const module = await import(pathToFileURL(resolve(LOCALES_DIR, "en", `${ns}.ts`)).href);
  return module.default;
}

const catalogue = new Map();
for (const ns of I18N_NAMESPACES) {
  try {
    catalogue.set(ns, flattenCatalogue(await loadNamespace(ns)));
  } catch (err) {
    console.error(`\nFATAL: cannot load namespace "${ns}": ${err.message}`);
    process.exit(1);
  }
}

/** `legacy` keys are addressed bare; every other namespace is addressed `ns:key`. */
const qualify = (ns, key) => (ns === LEGACY_NS ? key : `${ns}:${key}`);

const allKeys = [...catalogue].flatMap(([ns, keys]) => keys.map((key) => qualify(ns, key)));
const allKeySet = new Set(allKeys);
const legacyPrefixes = new Set(
  (catalogue.get(LEGACY_NS) ?? []).map((key) => key.slice(0, key.indexOf("."))),
);

console.log(`\nNamespaces: ${I18N_NAMESPACES.length} (default "${I18N_DEFAULT_NS}")`);
for (const [ns, keys] of catalogue) console.log(`  ${ns.padEnd(12)} ${keys.length}`);
console.log(`Catalogue leaf keys: ${allKeys.length}`);

// i18next plural forms: t("x.y") resolves to "x.y_one"/"x.y_other" at runtime
// (zoneChannelCount is the one live case) — the base key never appears as a leaf.
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];
const pluralBases = new Map();
for (const key of allKeys) {
  if (!PLURAL_SUFFIXES.some((suffix) => key.endsWith(suffix))) continue;
  const base = key.replace(/_(zero|one|two|few|many|other)$/, "");
  if (!pluralBases.has(base)) pluralBases.set(base, []);
  pluralBases.get(base).push(key);
}

const sourceFiles = walkSourceFiles(SRC_DIR);
console.log(`Source files scanned: ${sourceFiles.length}`);

const referenced = new Set();
const missingCandidates = new Map(); // key literal -> first file:line seen
const unhandledDynamicHeads = new Set();

/** A literal is a key reference only if its namespace half is one we know about. */
function classify(literal) {
  const qualified = QUALIFIED_KEY.exec(literal);
  if (qualified) {
    if (!catalogue.has(qualified[1]) || qualified[1] === LEGACY_NS) return null;
    // Tauri event names ("tray:lights-off", "hue:stream-status") share the ns:key
    // shape. No catalogue key is a single kebab-case segment — asserted below.
    return SINGLE_KEBAB_SEGMENT.test(qualified[2]) ? null : literal;
  }
  if (!DOTTED_KEY.test(literal)) return null;
  return legacyPrefixes.has(literal.slice(0, literal.indexOf("."))) ? literal : null;
}

for (const file of sourceFiles) {
  const raw = readFileSync(file, "utf-8");
  const source = stripComments(raw);
  const relPath = file.slice(ROOT.length + 1);
  const { literals, templateHeads } = extractLiterals(source);

  for (const lit of literals) {
    const key = classify(lit);
    if (key === null) continue;

    if (allKeySet.has(key)) {
      referenced.add(key);
    } else if (pluralBases.has(key)) {
      for (const form of pluralBases.get(key)) referenced.add(form);
    } else if (!missingCandidates.has(key)) {
      const lineNo = raw.slice(0, raw.indexOf(lit)).split("\n").length;
      missingCandidates.set(key, `${relPath}:${lineNo}`);
    }
  }

  for (const head of templateHeads) {
    const key = classify(head) ?? (QUALIFIED_KEY.test(head) ? head : null);
    if (key === null) continue;

    if (KNOWN_DYNAMIC_PREFIXES.includes(key)) {
      for (const candidate of allKeys) {
        if (candidate.startsWith(`${key}.`)) referenced.add(candidate);
      }
    } else {
      unhandledDynamicHeads.add(`${key} (${relPath})`);
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
const orphans = allKeys.filter((key) => !referenced.has(key)).sort();
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
// Registry integrity
// ---------------------------------------------------------------------------
console.log("\n[ Namespace registry integrity ]");

const moduleNamespaces = (lang) =>
  new Set(
    readdirSync(resolve(LOCALES_DIR, lang))
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .map((name) => name.replace(/\.ts$/, ""))
  );

const registered = new Set(I18N_NAMESPACES.filter((ns) => ns !== LEGACY_NS));
for (const lang of ["en", "tr"]) {
  const modules = moduleNamespaces(lang);
  const unregistered = [...modules].filter((ns) => !registered.has(ns)).sort();
  const unbacked = [...registered].filter((ns) => !modules.has(ns)).sort();
  check(
    unregistered.length === 0 && unbacked.length === 0,
    `${lang} locale modules match the registry (${modules.size})`,
    `${lang} locale drift — unregistered modules: [${unregistered}], registered without a module: [${unbacked}]`
  );
}

check(
  I18N_NAMESPACES.includes(I18N_DEFAULT_NS),
  `default namespace "${I18N_DEFAULT_NS}" is registered`,
  `default namespace "${I18N_DEFAULT_NS}" is not in I18N_NAMESPACES`
);

const kebabRootKeys = allKeys.filter((key) => SINGLE_KEBAB_SEGMENT.test(key.split(":").at(-1)));
check(
  kebabRootKeys.length === 0,
  "no catalogue key is a bare kebab-case segment (keeps it distinguishable from a Tauri event name)",
  `catalogue keys indistinguishable from Tauri event names: [${kebabRootKeys}] — rename or nest them`
);

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
