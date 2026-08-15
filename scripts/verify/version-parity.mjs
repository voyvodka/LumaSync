#!/usr/bin/env node
// Version parity across the four in-tree locations, so a drift fails on the PR
// rather than at tag time. Extraction mirrors `release.yml`'s `sed`/`jq` on
// purpose — reading the files differently could pass where the gate fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/** `1.5.5-rc.1` → `1.5.5`. MSI rejects a non-numeric prerelease identifier, so
 *  `wix.version` carries the core while the other three carry the full string. */
const core = (v) => v.split(/[-+]/)[0];

const checks = [];
let failed = 0;

function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failed += 1;
}

// --- Extract -----------------------------------------------------------------

/** Anchored at two spaces: a nested `"version"` inside a dependency is deeper. */
const pkgVersion = read("package.json").match(/^ {2}"version": "([^"]+)"/m)?.[1];

/** Anchored at column 0 — a dependency's `version = ` is always indented or
 *  preceded by a key inside an inline table. */
const cargoVersion = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1];

/** `current:` is the one place SECURITY.md names an exact release; the other
 *  rows of the support table are ranges (`1.5.x`, `< 1.4.0`). */
const securityVersion = read("SECURITY.md").match(/\(current: ([0-9][^)]*)\)/)?.[1];

const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));
const wixVersion = tauriConf?.bundle?.windows?.wix?.version;

// --- Present -----------------------------------------------------------------

const sources = [
  ["package.json", pkgVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["SECURITY.md", securityVersion],
  ["tauri.conf.json bundle.windows.wix.version", wixVersion],
];

for (const [file, value] of sources) {
  check(`${file} declares a version`, !!value, value ? `found ${value}` : "no version matched");
}

if (failed > 0) {
  report();
  process.exit(1);
}

// --- Agree -------------------------------------------------------------------

// The full version, prerelease suffix included, must be identical in three
// places; a tree reading plain `1.5.5` under tag `v1.5.5-rc.1` produces a feed
// that can never be upgraded, because `1.5.5 > 1.5.5` is false.
const full = pkgVersion;
for (const [file, value] of sources.slice(0, 3)) {
  check(
    `${file} matches package.json`,
    value === full,
    value === full ? value : `${value} != ${full}`,
  );
}

check(
  "wix.version is the core of the tree version",
  wixVersion === core(full),
  wixVersion === core(full) ? wixVersion : `${wixVersion} != ${core(full)}`,
);

check(
  "wix.version carries no prerelease suffix",
  !/[-+]/.test(wixVersion),
  wixVersion,
);

// `Cargo.lock` is refreshed by `cargo check`; a stale entry means the lockfile
// was not regenerated after the bump, and the release build would disagree.
const lockVersion = read("src-tauri/Cargo.lock")
  .match(/\[\[package\]\]\nname = "lumasync"\nversion = "([^"]+)"/)?.[1];
check(
  "Cargo.lock is refreshed for lumasync",
  lockVersion === cargoVersion,
  lockVersion ? `${lockVersion} vs ${cargoVersion}` : "no lumasync entry found",
);

// `release.yml` extracts notes with awk and stops at the first match, so a
// missing heading publishes an empty release and a duplicate truncates it.
const changelog = read("CHANGELOG.md");
const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
const coreHeadings = headings.filter((h) => h === core(full) || h === full);
check(
  `CHANGELOG.md has a section for ${core(full)}`,
  coreHeadings.length >= 1,
  coreHeadings.length ? coreHeadings.join(", ") : "no matching heading",
);
check(
  "CHANGELOG.md has no duplicate version heading",
  new Set(headings).size === headings.length,
  headings.length === new Set(headings).size
    ? `${headings.length} unique`
    : `duplicates: ${headings.filter((h, i) => headings.indexOf(h) !== i).join(", ")}`,
);

report();
process.exit(failed > 0 ? 1 : 0);

function report() {
  console.log("\n[ Version parity ]\n");
  for (const { label, ok, detail } of checks) {
    console.log(`  ${ok ? "✔" : "✖"}  ${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log("");
  console.log("=".repeat(44));
  if (failed > 0) {
    console.log(`✖  ${failed} of ${checks.length} version checks failed.`);
    console.log("   The four locations move in lockstep; then run `cargo check`.");
  } else {
    console.log(`✔  All ${checks.length} checks passed — version parity verified.`);
  }
}
