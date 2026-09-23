#!/usr/bin/env node
/**
 * Proves each window's capability grants exactly the app commands its frontend
 * can invoke.
 *
 * A missing grant compiles, builds and passes every other test; it fails only
 * as a rejected invoke in that one window at runtime — an updater modal at
 * startup, a Devices card that never fills. So the required set is derived
 * here from the code, not written down: from each window's entry modules, walk
 * the imports, keep only the exported functions and components something live
 * actually imports, and collect every `*_COMMANDS.X` (or literal `invoke("x")`)
 * they reference. That set must be granted, and nothing beyond it may be,
 * except the exceptions below — each with its reason.
 *
 * The walk is a static over-approximation at module and export granularity: an
 * export counts as called once a live module imports it. Where that is wider
 * than what a window really calls, the command is listed as withheld with the
 * call site that proves it. Policy: docs/architecture/ui-and-shell.md,
 * "Capabilities".
 *
 *   node scripts/verify/window-grants.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

let failures = 0;
const pass = (msg) => console.log(`  ✔  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✘  ${msg}`);
};
const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

// ---------------------------------------------------------------------------
// Windows, their entries, and the deliberate differences
// ---------------------------------------------------------------------------

/** Mounted by `src/main.tsx` in every window before the per-label tree. */
const BOOTSTRAP = [
  "src/app/providers.tsx",
  "src/features/i18n/languagePolicy.ts",
  "src/features/i18n/i18n.ts",
];

const WINDOWS = [
  {
    label: "main",
    capability: "default.json",
    root: "<App",
    entries: ["src/App.tsx", "src/features/shell/GlobalErrorBoundary.tsx", ...BOOTSTRAP],
    // Granted though no src/ module calls it: the dev mock's panel passes it
    // through to Rust from this window (`mock/ui/DevPanel.tsx`).
    extraGrants: { simulate_hue_fault: "mock/ui/DevPanel.tsx fault injection under tauri:mock" },
    withheld: {},
  },
  {
    label: "led-control-popup",
    capability: "preview-popup.json",
    root: "<ControlPopupApp",
    entries: [
      "src/features/preview/ui/ControlPopupApp.tsx",
      "src/features/shell/GlobalErrorBoundary.tsx",
      ...BOOTSTRAP,
    ],
    extraGrants: {},
    withheld: {
      replace_shell_state:
        "reached through loadShellState; the migration write-back runs in the main window first, and a refused one is logged and not fatal",
    },
  },
  {
    label: "led-twin-overlay-0",
    capability: "preview-overlay.json",
    root: "<LedTwinOverlay",
    entries: [
      "src/features/preview/ui/LedTwinOverlay.tsx",
      "src/features/preview/ui/TwinErrorBoundary.tsx",
      ...BOOTSTRAP,
    ],
    extraGrants: {},
    withheld: {
      patch_shell_state:
        "reached through the shared shellStore object; LedTwinOverlay only calls shellStore.load()",
      replace_shell_state:
        "reached through loadShellState; the migration write-back runs in the main window first, and a refused one is logged and not fatal",
    },
  },
];

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const read = (path) => readFileSync(path, "utf-8");

/** `SHELL_COMMANDS.GET_SHELL_STATE` → `get_shell_state`, from every contract map. */
const commandConstants = new Map();
for (const file of walk(join(SRC, "shared/contracts"))) {
  for (const block of read(file).matchAll(/export const (\w+_COMMANDS)\s*=\s*\{([\s\S]*?)\}\s*as const/g)) {
    for (const kv of stripComments(block[2]).matchAll(/(\w+)\s*:\s*"([a-z_0-9]+)"/g)) {
      commandConstants.set(`${block[1]}.${kv[1]}`, kv[2]);
    }
  }
}

const buildRs = read(join(ROOT, "src-tauri/build.rs"));
const manifestBlock = buildRs.match(/const APP_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/);
const appCommands = new Set(manifestBlock ? [...manifestBlock[1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]) : []);

function commandsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*_COMMANDS)\.([A-Z0-9_]+)\b/g)) {
    const command = commandConstants.get(`${m[1]}.${m[2]}`);
    if (command) found.add(command);
  }
  for (const m of text.matchAll(/\binvoke(?:<[^>]*>)?\(\s*"([a-z_0-9]+)"/g)) {
    if (appCommands.has(m[1])) found.add(m[1]);
  }
  return found;
}

function resolveSpecifier(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * A module as the walk sees it: its imports (local name → [file, imported
 * name]), its exported top-level declarations as separate segments, and the
 * rest as module-level text that runs whenever the module is loaded.
 */
const modules = new Map();
function parse(file) {
  if (modules.has(file)) return modules.get(file);
  const text = stripComments(read(file));
  const imports = new Map();
  const sideEffects = [];
  const importRe = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?|^import\s+["']([^"']+)["'];?/gm;
  for (const m of text.matchAll(importRe)) {
    if (m[4]) {
      const target = resolveSpecifier(file, m[4]);
      if (target) sideEffects.push(target);
      continue;
    }
    if (m[1]) continue;
    const target = resolveSpecifier(file, m[3]);
    if (!target) continue;
    const clause = m[2];
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const item = part.trim();
        if (!item || item.startsWith("type ")) continue;
        const [imported, local] = item.split(/\s+as\s+/).map((s) => s.trim());
        imports.set(local ?? imported, [target, imported]);
      }
    }
    const defaultName = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim().split(/\s+/)[0];
    if (defaultName && defaultName !== "*" && /^\w+$/.test(defaultName)) imports.set(defaultName, [target, "default"]);
  }

  // An import line names every binding it brings in; left in, it would make
  // each of them look used by the module's top level.
  const lines = text.replace(importRe, "").split("\n");
  const segments = new Map();
  const moduleLines = [];
  const declRe = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/;
  const topLevelRe = /^(export|import|function|async|const|let|var|class|type|interface|enum|declare)\b/;
  let current = null;
  for (const line of lines) {
    const decl = line.match(declRe);
    if (decl) {
      current = decl[1];
      segments.set(current, line + "\n");
      continue;
    }
    if (current && topLevelRe.test(line)) current = null;
    if (current) segments.set(current, segments.get(current) + line + "\n");
    else moduleLines.push(line);
  }
  const parsed = { file, imports, sideEffects, segments, moduleText: moduleLines.join("\n") };
  modules.set(file, parsed);
  return parsed;
}

const MODULE = "<module>";

function requiredCommands(entries) {
  const live = new Set();
  const queue = [];
  const mark = (file, name) => {
    const key = `${file}\u0000${name}`;
    if (live.has(key)) return;
    live.add(key);
    queue.push([file, name]);
  };
  for (const entry of entries) {
    const file = join(ROOT, entry);
    mark(file, MODULE);
    for (const name of parse(file).segments.keys()) mark(file, name);
  }

  const required = new Map();
  while (queue.length > 0) {
    const [file, name] = queue.shift();
    const mod = parse(file);
    if (name !== MODULE) mark(file, MODULE);
    const text = name === MODULE ? mod.moduleText : mod.segments.get(name) ?? "";
    if (name === MODULE) for (const target of mod.sideEffects) mark(target, MODULE);
    for (const command of commandsIn(text)) {
      if (!required.has(command)) required.set(command, `${file.slice(ROOT.length)} (${name})`);
    }
    for (const [local, [target, imported]] of mod.imports) {
      if (!new RegExp(`\\b${local}\\b`).test(text)) continue;
      const targetModule = parse(target);
      if (imported === "default") {
        mark(target, MODULE);
        for (const segment of targetModule.segments.keys()) mark(target, segment);
      } else if (targetModule.segments.has(imported)) {
        mark(target, imported);
      } else {
        mark(target, MODULE);
      }
    }
  }
  return required;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

console.log("\n[ Window command grants — capability files ↔ the code each window runs ]\n");

check(
  commandConstants.size > 0 && appCommands.size > 0,
  `read ${commandConstants.size} contract command constants and ${appCommands.size} manifest commands`,
  "EXTRACTION FAILED: no contract command maps or no build.rs APP_COMMANDS — every check below is empty",
);

const mainTsx = read(join(SRC, "main.tsx"));
for (const window of WINDOWS) {
  check(
    mainTsx.includes(window.root),
    `main.tsx still mounts ${window.root}> for ${window.label}`,
    `ENTRY DRIFT: main.tsx no longer mounts ${window.root}> — update this script's entry for ${window.label}`,
  );

  const capability = JSON.parse(read(join(ROOT, "src-tauri/capabilities", window.capability)));
  const granted = new Set(
    capability.permissions
      .filter((p) => typeof p === "string" && p.startsWith("allow-"))
      .map((p) => p.slice("allow-".length).replace(/-/g, "_")),
  );
  const required = requiredCommands(window.entries);

  const missing = [...required.keys()].filter((c) => !granted.has(c) && !(c in window.withheld)).sort();
  check(
    missing.length === 0,
    `${window.label}: all ${required.size - Object.keys(window.withheld).length} commands its code can invoke are granted`,
    `MISSING GRANT on ${window.label} — every invoke of these is refused at runtime:\n`
      + missing.map((c) => `       ${c}  ← ${required.get(c)}`).join("\n"),
  );

  const extra = [...granted].filter((c) => !required.has(c) && !(c in window.extraGrants)).sort();
  check(
    extra.length === 0,
    `${window.label}: grants nothing its code cannot invoke`,
    `EXCESS GRANT on ${window.label} — no reachable code invokes: ${extra.join(", ")}`,
  );

  for (const [command, reason] of Object.entries(window.withheld)) {
    check(
      required.has(command) && !granted.has(command),
      `${window.label}: withholds ${command} (${reason})`,
      `STALE EXCEPTION on ${window.label}: ${command} is ${granted.has(command) ? "granted" : "no longer reachable"} — drop it from "withheld"`,
    );
  }
  for (const [command, reason] of Object.entries(window.extraGrants)) {
    check(
      granted.has(command) && !required.has(command),
      `${window.label}: grants ${command} beyond its code (${reason})`,
      `STALE EXCEPTION on ${window.label}: ${command} — drop it from "extraGrants"`,
    );
  }
  const unknown = [...granted].filter((c) => !appCommands.has(c));
  check(
    unknown.length === 0,
    `${window.label}: every app grant names a registered command`,
    `UNKNOWN COMMAND GRANTED on ${window.label}: ${unknown.join(", ")}`,
  );
}

console.log("");
if (failures > 0) {
  console.log(`✘  ${failures} window-grant check(s) failed.`);
  process.exit(1);
}
console.log("✔  Every window is granted exactly the app commands its code can invoke.");
