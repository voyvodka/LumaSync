#!/usr/bin/env node
/**
 * Event-name single-source verifier.
 *
 * Tauri event names are a second IPC surface `verify:shell-contracts` does not
 * cover — that script pins `invoke()` command strings, not `.emit*()` /
 * `listen()` event strings. This script pins the event side the same way:
 *
 *   1. `src-tauri/src/events.rs` is the one place a Rust event string may be
 *      declared (`pub const X: &str = "...";`). Every other Rust module that
 *      used to own one of these now re-exports it (`pub use crate::events::X;`)
 *      rather than declaring it again — this script does not enforce the
 *      re-export shape, only that the *value* is not re-declared elsewhere.
 *   2. Every `src/shared/contracts/*.ts` grouped `*_EVENTS = { ... } as const`
 *      object must carry exactly the same set of string values as (1).
 *   3. No `.emit(`, `.emit_to(`, `.emit_all(`, `::listen(`, `.listen(`,
 *      `.listen_any(`, `.once(` call site (Rust) or `listen(`, `once(` call
 *      site (TS, scoped to files that import the real
 *      `@tauri-apps/api/event` binding) may pass a raw string literal that
 *      looks like an event name — it must go through a named constant.
 *
 * `tray:startup-state-changed` has no Rust producer (the tray checkbox that
 * used to emit it was removed) and is carried only as a TS-only allowlist
 * entry, with the reason next to it below — see `src/shared/contracts/shell.ts`.
 *
 *   node scripts/verify/event-names.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const RUST_EVENTS_FILE = join(ROOT, "src-tauri/src/events.rs");
const CONTRACTS_DIR = join(ROOT, "src/shared/contracts");

let failures = 0;
const pass = (msg) => console.log(`  ✔  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✘  ${msg}`);
};

// An event name is `scheme://path` (`lighting://mode-changed`) or
// `word:word-word` (`shell:close-to-tray`) — never a bare word, so this
// pattern does not false-positive on ordinary strings.
const EVENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*:(\/\/)?[a-zA-Z0-9-]+$/;

/** Frontend-only events with no Rust producer today, and why. Every entry
 * here needs the same reason recorded next to its TS declaration. */
const TS_ONLY_ALLOWLIST = new Map([
  [
    "tray:startup-state-changed",
    "the tray startup checkbox that used to emit it was removed; the frontend " +
      "listener (trayController.ts) is kept only for a possible future external-" +
      "autostart-toggle re-wiring — see TRAY_STARTUP_STATE_CHANGED_EVENT in shell.ts",
  ],
]);

/** Third-party event names (e.g. a raw `tauri://...` window event) that are
 * legitimately never behind one of our own constants. Empty today. */
const THIRD_PARTY_LITERAL_ALLOWLIST = new Set([]);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function walk(dir, matchExt, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, matchExt, out);
    else if (matchExt.includes(extname(name))) out.push(full);
  }
  return out;
}

/** Text between a call's opening paren (at `openParenIdx`) and its matching
 * close, tracking nested parens (`EventTarget::webview_window(...)` etc). */
function extractBalanced(source, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

/** Every string literal inside `argsText` that reads as an event name. */
function eventLiteralsIn(argsText) {
  const found = [];
  const stringPattern = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = stringPattern.exec(argsText))) {
    if (EVENT_NAME_PATTERN.test(m[1])) found.push(m[1]);
  }
  return found;
}

/** Call sites of `methodNames`, Rust-style (`.foo(` or `::foo(`) or bare
 * (`foo(`) TS-style, each with its raw event-name literals (if any). */
function findCallSiteViolations(source, methodNames, { bare = false } = {}) {
  const violations = [];
  for (const name of methodNames) {
    const prefix = bare ? "\\b" : "(?:\\.|::)";
    const re = new RegExp(`${prefix}${name}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(source))) {
      const openParenIdx = m.index + m[0].length - 1;
      const argsText = extractBalanced(source, openParenIdx);
      if (argsText === null) continue;
      for (const literal of eventLiteralsIn(argsText)) {
        if (THIRD_PARTY_LITERAL_ALLOWLIST.has(literal)) continue;
        violations.push({ method: name, literal });
      }
    }
  }
  return violations;
}

console.log("\n[ Event names — single source, Rust ↔ TS ]\n");

// ---------------------------------------------------------------------------
// 1. Rust canonical set — src-tauri/src/events.rs
// ---------------------------------------------------------------------------
const rustEventsSource = readFileSync(RUST_EVENTS_FILE, "utf8");
const rustEvents = new Map(); // name -> value
{
  const constPattern = /pub const ([A-Z0-9_]+): &str = "([^"]+)";/g;
  let m;
  while ((m = constPattern.exec(rustEventsSource))) {
    rustEvents.set(m[1], m[2]);
  }
}
check(
  rustEvents.size > 0,
  `harvested ${rustEvents.size} event constants from events.rs`,
  "harvested 0 event constants from events.rs — the const pattern drifted from this script's regex",
);

function check(ok, good, bad) {
  if (ok) pass(good);
  else fail(bad);
}

// No other Rust module may declare (not re-export) one of these values again.
{
  const rustFiles = walk(join(ROOT, "src-tauri/src"), [".rs"]).filter(
    (f) => f !== RUST_EVENTS_FILE,
  );
  const redeclared = [];
  const declPattern = /pub const [A-Z0-9_]+: &str = "([^"]+)";/g;
  const rustValues = new Set(rustEvents.values());
  for (const file of rustFiles) {
    const src = stripComments(readFileSync(file, "utf8"));
    let m;
    while ((m = declPattern.exec(src))) {
      if (rustValues.has(m[1])) redeclared.push(`${relative(ROOT, file)}: "${m[1]}"`);
    }
  }
  check(
    redeclared.length === 0,
    "no event string is declared with `pub const` outside events.rs",
    `event string(s) redeclared outside events.rs (should be \`pub use crate::events::X;\` instead): ${redeclared.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// 2. TS canonical set — every `*_EVENTS = { ... } as const` in the contracts
// ---------------------------------------------------------------------------
const tsFiles = readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".ts") && f !== "ipc.ts");
/** name -> value, for every `export const NAME = "value"` in the contracts —
 * resolves a group object's bare-identifier members (`STATE_CHANGED: FOO`). */
const tsNamedConsts = new Map();
const tsSources = new Map();
for (const file of tsFiles) {
  const full = join(CONTRACTS_DIR, file);
  const src = readFileSync(full, "utf8");
  tsSources.set(file, src);
  const declPattern = /export const ([A-Z0-9_]+)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = declPattern.exec(src))) {
    if (EVENT_NAME_PATTERN.test(m[2])) tsNamedConsts.set(m[1], m[2]);
  }
}

const tsGroupEvents = new Map(); // value -> [{ file, group, key }]
for (const [file, src] of tsSources) {
  const groupPattern = /export const ([A-Z0-9_]+_EVENTS)\s*=\s*\{([\s\S]*?)\n\}\s*as const;/g;
  let gm;
  while ((gm = groupPattern.exec(src))) {
    const [, groupName, body] = gm;
    const entryPattern = /([A-Z0-9_]+):\s*(?:"([^"]+)"|([A-Z0-9_]+))/g;
    let em;
    while ((em = entryPattern.exec(body))) {
      const [, key, literal, identifier] = em;
      const value = literal ?? tsNamedConsts.get(identifier);
      if (value === undefined) {
        fail(
          `${file} > ${groupName}.${key} references "${identifier}", which is not a resolvable ` +
            `"export const X = \\"...\\"" in any contracts file — event-names.mjs cannot resolve it`,
        );
        continue;
      }
      const list = tsGroupEvents.get(value) ?? [];
      list.push({ file, group: groupName, key });
      tsGroupEvents.set(value, list);
    }
  }
}
check(
  tsGroupEvents.size > 0,
  `harvested ${tsGroupEvents.size} distinct event values from *_EVENTS groups across ${tsFiles.length} contract files`,
  "harvested 0 event values from any *_EVENTS group — the group pattern drifted from this script's regex",
);

// ---------------------------------------------------------------------------
// 3. Bidirectional parity
// ---------------------------------------------------------------------------
console.log("\n[ Rust → TS: every emitted event has a declared TS constant ]");
for (const [name, value] of rustEvents) {
  check(
    tsGroupEvents.has(value),
    `"${value}" (Rust ${name}) has a TS *_EVENTS entry`,
    `"${value}" (Rust ${name}) has NO *_EVENTS entry in any src/shared/contracts/*.ts file`,
  );
}

console.log("\n[ TS → Rust: every declared TS constant is either emitted by Rust or allowlisted ]");
const rustValues = new Set(rustEvents.values());
for (const [value, sites] of tsGroupEvents) {
  if (rustValues.has(value)) {
    pass(`"${value}" matches a Rust events.rs constant`);
    continue;
  }
  if (TS_ONLY_ALLOWLIST.has(value)) {
    pass(`"${value}" is TS-only (allowlisted: ${TS_ONLY_ALLOWLIST.get(value)})`);
    continue;
  }
  const where = sites.map((s) => `${s.file} > ${s.group}.${s.key}`).join(", ");
  fail(
    `"${value}" (${where}) has no Rust events.rs producer and is not in TS_ONLY_ALLOWLIST — ` +
      `either Rust never emits it (dead code — remove it) or events.rs is missing the constant`,
  );
}

// Every allowlist entry must still be referenced somewhere, or it is dead
// weight nobody would notice growing.
for (const value of TS_ONLY_ALLOWLIST.keys()) {
  check(
    tsGroupEvents.has(value),
    `TS_ONLY_ALLOWLIST entry "${value}" is still declared in a *_EVENTS group`,
    `TS_ONLY_ALLOWLIST entry "${value}" is declared nowhere — remove the allowlist entry`,
  );
}

// ---------------------------------------------------------------------------
// 4. No raw string literal at a call site, either side
// ---------------------------------------------------------------------------
console.log("\n[ No raw event-name literal at an emit/listen call site ]");

{
  const rustFiles = walk(join(ROOT, "src-tauri/src"), [".rs"]);
  const violations = [];
  for (const file of rustFiles) {
    const src = stripComments(readFileSync(file, "utf8"));
    const hits = findCallSiteViolations(src, ["emit", "emit_to", "emit_all", "listen", "listen_any", "once"]);
    for (const hit of hits) violations.push(`${relative(ROOT, file)}: ${hit.method}("${hit.literal}")`);
  }
  check(
    violations.length === 0,
    "no Rust .emit*()/.listen*()/::listen() call site uses a raw event-name literal",
    `raw event-name literal(s) at a Rust call site (use the crate::events constant instead): ${violations.join(", ")}`,
  );
}

{
  const tsCandidateDirs = ["src", "mock"];
  const violations = [];
  for (const dir of tsCandidateDirs) {
    const files = walk(join(ROOT, dir), [".ts", ".tsx"]).filter(
      (f) => !f.includes(`${dir}/__tests__/`) && !f.includes(`${dir}\\__tests__\\`),
    );
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      if (!/from\s+"@tauri-apps\/api\/event"/.test(raw)) continue;
      if (!/\bimport\s*\{[^}]*\b(listen|once)\b[^}]*\}\s*from\s*"@tauri-apps\/api\/event"/.test(raw)) continue;
      const src = stripComments(raw);
      const hits = findCallSiteViolations(src, ["listen", "once"], { bare: true });
      for (const hit of hits) violations.push(`${relative(ROOT, file)}: ${hit.method}("${hit.literal}")`);
    }
  }
  check(
    violations.length === 0,
    "no TS listen()/once() call site (importing the real @tauri-apps/api/event binding) uses a raw event-name literal",
    `raw event-name literal(s) at a TS call site (use a *_EVENTS constant instead): ${violations.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
