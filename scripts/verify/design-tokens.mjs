#!/usr/bin/env node
/**
 * Every `var(--lm-*)` must name a token that exists.
 *
 * This exists because a reference to an undefined custom property is the
 * quietest failure CSS has. It does not warn, it does not fall back to
 * anything visible, and it does not break the layout — the declaration is
 * simply dropped. The room-map zoom controls shipped styled entirely in
 * `--lm-text-dim`, `--lm-text` and `--lm-accent`, none of which is defined
 * anywhere (the token layer is `--lm-ink-dim`, `--lm-ink`, `--lm-amber`), and
 * the consequence was not a visual mess: the buttons looked plausible and
 * their `focus-visible` outline resolved to nothing, so the one control group
 * that exists for people who cannot use a wheel gesture had no visible focus
 * indicator. Nobody noticed for a release, because there is nothing to notice.
 *
 * A typo'd token is the same bug as a typo'd i18n key, and that already has a
 * ratchet. This is the same guard for the colour layer.
 *
 * **A fallback is an explicit answer, so it passes.** `var(--lm-fill, 0%)` is a
 * property set inline at runtime; declaring it in `:root` would be wrong. The
 * fallback is how the author says "undefined here is intended", and the check
 * reads it that way rather than forcing a fake declaration. The same reading
 * makes a fallback on a `:root` token a mistake, and that fails below.
 *
 * Also checked: no arbitrary `[var(--lm-*)]` utility where `@theme` gives the
 * token a name, and a shrink-only baseline of raw hex literals in src/.
 *
 *   node scripts/verify/design-tokens.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, extname, resolve } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const STYLESHEET = join(ROOT, "src/styles.css");
const SCANNED = ["src", "mock"];
const EXTENSIONS = [".ts", ".tsx", ".css"];

let failures = 0;
const pass = (msg) => console.log(`  ✔  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  ✘  ${msg}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out);
    } else if (EXTENSIONS.includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

console.log("\n[ Design tokens ]\n");

// `styles.css` is an ordered import list; inline it the way the build does.
function inlineImports(file) {
  return readFileSync(file, "utf-8").replace(/^@import\s+"(\.[^"]+)"[^;\n]*;$/gm, (_, rel) =>
    inlineImports(resolve(dirname(file), rel)),
  );
}

const stylesheet = inlineImports(STYLESHEET);
const defined = new Set(
  [...stylesheet.matchAll(/^\s*(--lm-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
);

if (defined.size === 0) {
  fail("no --lm-* token declarations found in src/styles.css or its imports — this check cannot verify anything");
} else {
  pass(`${defined.size} tokens declared in src/styles.css and its imports`);
}

// A bare reference is `var(--lm-x)`; one with a fallback is `var(--lm-x, …)`.
// Only the bare form is a claim that the token exists.
const BARE_REFERENCE = /var\(\s*(--lm-[a-z0-9-]+)\s*\)/g;

const undefinedRefs = new Map();
let referenced = 0;

for (const dir of SCANNED) {
  for (const file of walk(join(ROOT, dir))) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(BARE_REFERENCE)) {
      referenced += 1;
      const token = match[1];
      if (defined.has(token)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      const where = `${file.replace(ROOT, "")}:${line}`;
      const seen = undefinedRefs.get(token) ?? [];
      seen.push(where);
      undefinedRefs.set(token, seen);
    }
  }
}

if (undefinedRefs.size === 0) {
  pass(`every one of the ${referenced} bare var(--lm-*) references resolves`);
} else {
  for (const [token, places] of undefinedRefs) {
    fail(
      `${token} is referenced but never declared — the declaration is silently dropped, ` +
        `so this renders as "no style" rather than as an error: ${places.join(", ")}`,
    );
  }
}

// A token with a `@theme` name has a utility (`text-ink`); the arbitrary
// `text-[var(--lm-ink)]` spelling of the same thing splits the vocabulary.
const THEMED = new Map(
  [...stylesheet.matchAll(/^\s*--(color|font)-([a-z0-9-]+)\s*:\s*var\((--lm-[a-z0-9-]+)\)/gm)].map(
    (m) => [m[3], m[1] === "font" ? `font-${m[2]}` : m[2]],
  ),
);
const ARBITRARY = /\[(?:[a-z-]+:)?var\((--lm-[a-z0-9-]+)\)\]/g;
const arbitrary = [];
for (const dir of SCANNED) {
  for (const file of walk(join(ROOT, dir))) {
    if (extname(file) === ".css") continue;
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(ARBITRARY)) {
      if (!THEMED.has(match[1])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      arbitrary.push(`${file.replace(ROOT, "")}:${line} ${match[0]} → ${THEMED.get(match[1])}`);
    }
  }
}
if (THEMED.size === 0) {
  fail("no `@theme` mapping of --lm-* tokens found — src/styles/theme.css is missing or unimported");
} else if (arbitrary.length === 0) {
  pass(`no arbitrary [var(--lm-*)] utility where one of the ${THEMED.size} named utilities exists`);
} else {
  fail(`arbitrary token utilities with a named equivalent:\n       ${arbitrary.join("\n       ")}`);
}

// A fallback on a `:root` token can never be used, and it is a second copy of
// the colour that silently drifts: `var(--lm-ink-dim, #aab1bc)` was not even
// the token's value. Tokens scoped to a feature (`--lm-notice-tone`) or set
// inline at runtime (`--lm-fill`) are not `:root` tokens and keep theirs.
const TOKENS_FILE = join(ROOT, "src/styles/tokens.css");
const rootTokens = new Set(
  [...readFileSync(TOKENS_FILE, "utf-8").matchAll(/^\s*(--lm-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
);
const FALLBACK = /var\(\s*(--lm-[a-z0-9-]+)\s*,/g;
const redundant = [];
for (const dir of SCANNED) {
  for (const file of walk(join(ROOT, dir))) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(FALLBACK)) {
      if (!rootTokens.has(match[1])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      redundant.push(`${file.replace(ROOT, "")}:${line} ${match[1]}`);
    }
  }
}
if (redundant.length === 0) {
  pass(`no fallback on any of the ${rootTokens.size} :root tokens`);
} else {
  fail(`fallbacks on :root tokens, which always resolve — drop them:\n       ${redundant.join("\n       ")}`);
}

// Raw hex in src/ is a ratchet: every colour that has a token should name it.
// What remains is mostly deliberate — SVG and canvas art, zone identity data,
// LED test-pattern swatches — so the count may only go down.
const HEX_BASELINE_FILE = join(ROOT, "scripts/verify/hex-literal-baseline.txt");
const hexBaseline = Number(
  readFileSync(HEX_BASELINE_FILE, "utf-8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))[0],
);
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
let hexCount = 0;
for (const file of walk(join(ROOT, "src"))) {
  if (file.includes("/__tests__/") || file === TOKENS_FILE) continue;
  hexCount += (stripComments(readFileSync(file, "utf-8")).match(HEX) ?? []).length;
}
if (!Number.isFinite(hexBaseline)) {
  fail(`${HEX_BASELINE_FILE.replace(ROOT, "")} holds no number`);
} else if (hexCount > hexBaseline) {
  fail(
    `${hexCount} raw hex literals in src/, baseline ${hexBaseline} — use the --lm-* token ` +
      "(or its named utility) instead of a new hex",
  );
} else if (hexCount < hexBaseline) {
  pass(`${hexCount} raw hex literals in src/ — lower scripts/verify/hex-literal-baseline.txt to ${hexCount}`);
} else {
  pass(`${hexCount} raw hex literals in src/ (baseline ${hexBaseline})`);
}

console.log(`\n${"=".repeat(44)}`);
if (failures === 0) {
  console.log("✔  Design tokens verified.\n");
  process.exit(0);
}
console.log(`✘  ${failures} check(s) failed.\n`);
process.exit(1);
