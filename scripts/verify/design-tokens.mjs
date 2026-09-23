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
 * reads it that way rather than forcing a fake declaration.
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

console.log(`\n${"=".repeat(44)}`);
if (failures === 0) {
  console.log("✔  Design tokens verified — no reference to a token that does not exist.\n");
  process.exit(0);
}
console.log(`✘  ${failures} check(s) failed — a style is silently doing nothing.\n`);
process.exit(1);
