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

const CONTRACTS_DIR = resolve(ROOT, "src/shared/contracts");

// Static heads of live `` t(`prefix.${x}`) `` sites. An unlisted head is only a
// note(), but orphan accounting under it is unreliable until the list catches up.
// phase01-shell-contracts.mjs reads this array literal, so it stays a flat list.
const KNOWN_DYNAMIC_PREFIXES = [
  "device:healthCheck.steps.labels",
  "hue:runtime.codes",
  "hue:runtime.states",
  "hue:runtime.triggerSource",
  "hue:runtime.writeback.codes",
  "common:captureFailed",
  "common:hotplug.targetLabel",
  "preview:pattern",
  "preview:status",
  "preview:test.speed",
  "roomMap:furniture.type",
  "settings:nav.sections",
  "telemetry:queueHealth",
];

// What `${x}` can be at each dynamic site, read from src/shared/contracts/.
// Only children in that set count as referenced, so a key whose value left the
// contract becomes an orphan instead of hiding under the head. A member with no
// key fails, because the site would render the raw key. `exempt` lists members
// the site never receives; `extra` lists segments reachable without being a
// contract value.
//
// A source is "<file> <NAME>" (a const object/array or a string-literal type),
// "<file> <CONST>.<MEMBER>" (one const member), or "<file> <Interface>.<field>".
const DYNAMIC_PREFIX_DOMAINS = {
  "device:healthCheck.steps.labels": { sources: ["device.ts DEVICE_HEALTH_STEPS"] },
  "hue:runtime.codes": {
    sources: ["hue.ts HUE_RUNTIME_STATUS"],
    // An absent wire field interpolates as "undefined"; so for the next two.
    extra: ["undefined"],
    // Carried on the writeback status, never on HueRuntimeStatus.code.
    exempt: ["HUE_CHANNEL_POSITIONS_UPDATED", "HUE_CHANNEL_POSITIONS_FAILED"],
  },
  "hue:runtime.states": { sources: ["hue.ts HUE_RUNTIME_STATES"], extra: ["undefined"] },
  "hue:runtime.triggerSource": {
    sources: ["hue.ts HUE_RUNTIME_TRIGGER_SOURCE"],
    extra: ["undefined"],
  },
  // HueChannelWritebackStatusCode minus its success member.
  "hue:runtime.writeback.codes": {
    sources: [
      "roomMap.ts CHANNEL_WRITEBACK_STATUS",
      "hue.ts HUE_STATUS.IP_INVALID",
      "hue.ts HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED",
    ],
  },
  "common:captureFailed": { sources: ["capture.ts CAPTURE_FAILURE_BUCKET"] },
  "common:hotplug.targetLabel": { sources: ["hue.ts HueRuntimeTarget"] },
  "preview:pattern": { sources: ["preview.ts LED_TEST_PATTERN_KIND"] },
  // The popup's error line: exactly useTestPatternRunner's ERROR_CODES.
  "preview:status": {
    sources: [
      "preview.ts LED_TEST_STATUS.PATTERN_NO_CALIBRATION",
      "preview.ts LED_TEST_STATUS.PATTERN_INVALID_PARAMS",
      "preview.ts LED_TEST_STATUS.PATTERN_RUNTIME_ERROR",
    ],
  },
  "preview:test.speed": { sources: ["preview.ts TestPatternSpeed"] },
  "roomMap:furniture.type": { sources: ["roomMap.ts FurniturePlacement.type"] },
  "settings:nav.sections": { sources: ["shell.ts SECTION_IDS"] },
  "telemetry:queueHealth": { sources: ["telemetry.ts TELEMETRY_QUEUE_HEALTH"] },
};

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

const contractSources = new Map();
function contractSource(file) {
  if (!contractSources.has(file)) {
    contractSources.set(file, stripComments(readOrEmpty(resolve(CONTRACTS_DIR, file), `contract ${file}`)));
  }
  return contractSources.get(file);
}

/** Values of a union made only of string literals; null if anything else is in it. */
function literalUnion(text) {
  const values = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const rest = text.replace(/"[^"]*"/g, "").replace(/[|\s]/g, "");
  return values.length > 0 && rest === "" ? values : null;
}

/** Resolve one DYNAMIC_PREFIX_DOMAINS source to its values; null when it cannot be read exactly. */
function resolveDomainSource(spec) {
  const [file, ref] = spec.split(" ");
  const [name, member] = ref.split(".");
  const source = contractSource(file);

  const constBlock = source.match(
    new RegExp(`export const ${name}\\s*=\\s*([\\[{])([\\s\\S]*?)\\n[\\]}] as const;`)
  );
  if (constBlock) {
    if (constBlock[1] === "[") return member ? null : literalUnion(constBlock[2].replace(/,/g, "|"));
    const lines = constBlock[2].split("\n").map((line) => line.trim()).filter(Boolean);
    const entries = lines.map((line) => line.match(/^([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)",?$/));
    // A member whose value is not a string literal would be silently dropped.
    if (entries.some((entry) => entry === null)) return null;
    const byName = new Map(entries.map((entry) => [entry[1], entry[2]]));
    if (member) return byName.has(member) ? [byName.get(member)] : null;
    return [...byName.values()];
  }

  if (!member) {
    const alias = source.match(new RegExp(`export type ${name}\\s*=([^;]*);`));
    return alias ? literalUnion(alias[1]) : null;
  }

  const iface = source.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  const field = iface?.[1].match(new RegExp(`^\\s*${member}\\??:([^;]*);`, "m"));
  return field ? literalUnion(field[1]) : null;
}

// A key segment: letters, digits, `_`/`-` (covers SCREAMING_SNAKE_CASE status
// codes and kebab-case section ids like "led-setup"), must start with a letter.
const SEGMENT = "[A-Za-z][A-Za-z0-9_-]*";
const QUALIFIED_KEY = new RegExp(`^(${SEGMENT}):(${SEGMENT}(\\.${SEGMENT})*)$`);
const SINGLE_KEBAB_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*(-[A-Za-z0-9_]+)+$/;

/**
 * Extract candidate key-literal strings from a source file: every quoted or
 * template string, plus the static head of every template literal (the part
 * before the first `${`, trailing dot stripped).
 *
 * A lexer rather than one regex, because strings inside a template's `${…}`
 * are real references: `` `${t("shell:fpsHud.latencyUnit")}` `` hid its key
 * from a regex that consumed the whole template, so live keys were counted as
 * orphans and a typo there could never be reported as missing.
 */
function extractLiterals(source) {
  const literals = [];
  const templateHeads = [];
  const n = source.length;
  let i = 0;

  function readQuoted(quote) {
    let j = i + 1;
    let text = "";
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        text += source.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === quote) {
        literals.push(text);
        i = j + 1;
        return;
      }
      if (c === "\n") break;
      text += c;
      j++;
    }
    // Unterminated on its line, so not a string (an apostrophe in JSX text).
    i++;
  }

  function readTemplate() {
    i++;
    let text = "";
    let head = null;
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        break;
      }
      if (c === "$" && source[i + 1] === "{") {
        if (head === null) head = text;
        i += 2;
        scan(true);
        continue;
      }
      text += c;
      i++;
    }
    if (head === null) {
      literals.push(text);
    } else {
      const trimmed = head.replace(/\.$/, "");
      if (trimmed.length > 0) templateHeads.push(trimmed);
    }
  }

  function scan(inExpression) {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      if (c === '"' || c === "'") {
        readQuoted(c);
        continue;
      }
      if (c === "`") {
        readTemplate();
        continue;
      }
      if (inExpression) {
        if (c === "{") {
          depth++;
        } else if (c === "}") {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
      }
      i++;
    }
  }

  scan(false);
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

const catalogue = new Map();
for (const ns of I18N_NAMESPACES) {
  try {
    const module = await import(pathToFileURL(resolve(LOCALES_DIR, "en", `${ns}.ts`)).href);
    catalogue.set(ns, flattenCatalogue(module.default));
  } catch (err) {
    console.error(`\nFATAL: cannot load namespace "${ns}": ${err.message}`);
    process.exit(1);
  }
}

const allKeys = [...catalogue].flatMap(([ns, keys]) => keys.map((key) => `${ns}:${key}`));
const allKeySet = new Set(allKeys);

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

const domainFailures = [];
const prefixDomains = new Map(); // prefix -> Set of reachable first segments
for (const prefix of KNOWN_DYNAMIC_PREFIXES) {
  const domain = DYNAMIC_PREFIX_DOMAINS[prefix];
  if (domain === undefined) {
    domainFailures.push(`"${prefix}" has no DYNAMIC_PREFIX_DOMAINS entry`);
    continue;
  }
  const values = new Set(domain.extra ?? []);
  for (const spec of domain.sources) {
    const resolved = resolveDomainSource(spec);
    if (resolved === null) {
      domainFailures.push(`"${prefix}": cannot read "${spec}" from src/shared/contracts/ exactly`);
      continue;
    }
    for (const value of resolved) values.add(value);
  }
  prefixDomains.set(prefix, values);
}
for (const prefix of Object.keys(DYNAMIC_PREFIX_DOMAINS)) {
  if (!KNOWN_DYNAMIC_PREFIXES.includes(prefix)) {
    domainFailures.push(`"${prefix}" has a domain but is not in KNOWN_DYNAMIC_PREFIXES`);
  }
}

const referenced = new Set();
const missingCandidates = new Map(); // key literal -> first file:line seen
const unhandledDynamicHeads = new Set();
const seenDynamicPrefixes = new Set();

/** A literal is a key reference only if its namespace half is a registered one. */
function classify(literal) {
  const qualified = QUALIFIED_KEY.exec(literal);
  if (qualified === null || !catalogue.has(qualified[1])) return null;
  // Tauri event names ("tray:lights-off", "hue:stream-status") share the ns:key
  // shape. No catalogue key is a single kebab-case segment — asserted below.
  return SINGLE_KEBAB_SEGMENT.test(qualified[2]) ? null : literal;
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
    const key = classify(head);
    if (key === null) continue;

    if (KNOWN_DYNAMIC_PREFIXES.includes(key)) {
      seenDynamicPrefixes.add(key);
      const reachable = prefixDomains.get(key) ?? new Set();
      for (const candidate of allKeys) {
        if (!candidate.startsWith(`${key}.`)) continue;
        if (reachable.has(candidate.slice(key.length + 1).split(".")[0])) referenced.add(candidate);
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
// Dynamic prefix domains (FATAL)
// ---------------------------------------------------------------------------
console.log("\n[ Dynamic prefix domains ]");
for (const message of domainFailures) fail(`DOMAIN ${message}`);

const hasKeyFor = (prefix, segment) =>
  allKeySet.has(`${prefix}.${segment}`) || allKeys.some((key) => key.startsWith(`${prefix}.${segment}.`));

for (const [prefix, values] of prefixDomains) {
  const { exempt = [], extra = [] } = DYNAMIC_PREFIX_DOMAINS[prefix];
  const unlabelled = [...values].filter((value) => !exempt.includes(value) && !hasKeyFor(prefix, value));
  const staleExempt = exempt.filter((value) => !values.has(value) || hasKeyFor(prefix, value));
  const staleExtra = extra.filter((value) => !hasKeyFor(prefix, value));
  const problems = [
    ...unlabelled.map((value) => `"${prefix}.${value}" has no catalogue key, so the site would render the raw key`),
    ...staleExempt.map((value) => `exemption "${value}" under "${prefix}" is no longer needed`),
    ...staleExtra.map((value) => `extra "${value}" under "${prefix}" has no catalogue key`),
  ];
  if (!seenDynamicPrefixes.has(prefix)) {
    problems.push(`"${prefix}" is listed but no template head in src/ uses it — remove it`);
  }
  if (problems.length === 0) {
    pass(`${prefix}.* covers its ${values.size} contract value(s)`);
  } else {
    for (const problem of problems) fail(`DOMAIN ${problem}`);
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

const registered = new Set(I18N_NAMESPACES);
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
