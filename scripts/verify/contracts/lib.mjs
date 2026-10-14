import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = resolve(VERIFY_DIR, "../..");

let errors = 0;
let checks = 0;

/** The run's totals, for the summary the entry script prints. */
export function totals() {
  return { errors, checks };
}

export function pass(msg) {
  checks++;
  console.log(`  ✔  ${msg}`);
}

export function fail(msg) {
  errors++;
  checks++;
  console.error(`  ✘  ${msg}`);
}

/**
 * Informational, non-asserting log line. Unlike pass()/fail() it does NOT
 * touch the `checks`/`errors` counters, so it can surface a "known-pending"
 * fact (e.g. a Phase 0 command whose Rust handler lands in Phase 1) without
 * coloring the run pass or fail.
 */
export function note(msg) {
  console.log(`  \u2022  ${msg}`);
}

export function check(condition, passMsg, failMsg) {
  if (condition) {
    pass(passMsg);
  } else {
    fail(failMsg);
  }
}

export function readOrEmpty(path, label) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    console.error(`\nWARN: Cannot read ${label} contract file: ${path}`);
    return "";
  }
}

export function rustStructFields(source, structName) {
  const block = source.match(
    new RegExp(`pub struct ${structName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  );
  if (!block) return null;
  return [...block[1].matchAll(/^\s*pub\s+([a-z0-9_]+)\s*:/gm)].map((m) =>
    m[1].replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
  );
}

/** Members of an `export const NAME = { ... } as const;` block. */
export function constMembers(source, name) {
  const block = source.match(new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\} as const;`));
  return block ? [...block[1].matchAll(/:\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]) : [];
}

export function checkWireUnion(label, emitted, declared, pinnedCount) {
  const emittedSet = [...new Set(emitted)].sort();
  const declaredSet = [...new Set(declared)].sort();
  check(
    emittedSet.length === pinnedCount,
    `${label}: harvested exactly ${pinnedCount} emitted codes`,
    `HARVEST COUNT DRIFT (${label}): expected ${pinnedCount}, got ${emittedSet.length} `
      + `[${emittedSet.join(", ")}] — a code was added, removed, or hoisted into a `
      + `constant the literal harvest cannot see. Bump the pin deliberately.`
  );
  for (const code of emittedSet.filter((c) => !declaredSet.includes(c))) {
    fail(`${label}: Rust emits "${code}" but the wire union does not include it`);
  }
  for (const code of declaredSet.filter((c) => !emittedSet.includes(c))) {
    fail(
      `${label}: the wire union declares "${code}" but no Rust producer puts it on `
        + `this shape — drop it from the union or wire up the producer`
    );
  }
  check(
    emittedSet.join(",") === declaredSet.join(","),
    `${label}: emitted set equals the declared union (${emittedSet.length} codes)`,
    `${label}: wire union and emitted set differ (listed above)`
  );
}

export function normalizeSourcePath(file) {
  return file.replaceAll("\\", "/");
}

export function walkSourceFiles(dir, match, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, match, out);
    else if (match.test(entry.name)) out.push(normalizeSourcePath(full));
  }
  return out;
}

/** Rust files reached only through a `#[cfg(test)] mod name;` declaration. Their
 *  codes are emitted by integration tests, not by a command — `ipc_tests/` was
 *  claiming nine as production. Keyed on the declaration, so a second one needs
 *  no edit here; there is no directory-name convention to lean on. */
export function rustTestOnlyPaths(root) {
  const paths = new Set();
  for (const file of walkSourceFiles(root, /\.rs$/)) {
    // `mod x;` in `mod.rs`/`lib.rs` is a sibling file; in any other `foo.rs`
    // it lives under `foo/`, which is where `lighting_mode.rs`'s tests are.
    const name = file.split("/").pop();
    const base = ["mod.rs", "lib.rs", "main.rs"].includes(name)
      ? dirname(file)
      : resolve(dirname(file), name.replace(/\.rs$/, ""));
    for (const m of readFileSync(file, "utf-8").matchAll(/^#\[cfg\(test\)\]\s*\nmod\s+(\w+)\s*;/gm)) {
      paths.add(normalizeSourcePath(resolve(base, `${m[1]}.rs`)));
      paths.add(normalizeSourcePath(resolve(base, m[1])));
    }
  }
  return paths;
}

/** Production Rust: the crate minus the test-only modules above. */
export function walkRustSourceFiles(root) {
  const testOnly = rustTestOnlyPaths(resolve(ROOT, "src-tauri/src"));
  return walkSourceFiles(root, /\.rs$/).filter(
    (file) => ![...testOnly].some((p) => file === p || file.startsWith(`${p}/`))
  );
}

// A prose mention is not a declaration — the miss that hid DEVICE_NOT_CONNECTED
// behind three comments. Biased toward false positives on purpose.
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Never "simplify" back to `split(...)[0]`: production code follows a test
 *  module in two files, and truncating there hid three registered commands and
 *  five codes from every ratchet. Column-0 `}` beats a brace counter. */
export function stripRustTestModules(source) {
  const lines = source.split("\n");
  const kept = [];
  let inTestModule = false;
  for (let i = 0; i < lines.length; i++) {
    // `mod name {` opens a body to skip; `mod name;` declares one living in
    // another file and has none. Skipping on the declaration runs to the next
    // column-0 `}` and eats whatever it belongs to (lib.rs 48→115).
    if (!inTestModule && /^#\[cfg\(test\)\]\s*$/.test(lines[i]) && /^mod\s+\w+\s*\{/.test(lines[i + 1] ?? "")) {
      inTestModule = true;
      continue;
    }
    if (inTestModule) {
      if (lines[i] === "}") inTestModule = false;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

export function harvestCodes(files) {
  const found = new Set();
  for (const file of files) {
    let text = stripComments(readFileSync(file, "utf-8"));
    if (file.endsWith(".rs")) {
      text = stripRustTestModules(text);
      // `env!("CARGO_PKG_VERSION")` is a compile-time variable name, not a code
      // crossing the IPC boundary. Without this it harvests as an undeclared
      // producer and can only be silenced by polluting the ratchet.
      text = text.replace(/\b(?:option_)?env!\s*\(\s*"[^"]*"\s*\)/g, "env!()");
      // Same for a runtime lookup: `std::env::var_os("LUMASYNC_NO_DEVTOOLS")`
      // names an environment variable, which never crosses the IPC boundary.
      text = text.replace(/\benv::(?:var|var_os|remove_var|set_var)\s*\(\s*"[^"]*"/g, "env::var(");
    }
    // `"CODE: detail"` counts too — Err arms carry the code as a prefix (#42).
    for (const m of text.matchAll(/"([A-Z][A-Z0-9_]{4,})(?:"|:\s)/g)) {
      const code = m[1];
      // Underscore-required drops CLOCKWISE/TEXTAREA without an allowlist that
      // rots; a trailing one marks a `.startsWith()` prefix, not a code.
      if (!code.includes("_") || code.endsWith("_")) continue;
      found.add(code);
    }
  }
  return found;
}
