#!/usr/bin/env node
// Removes Rust build output that no build has read for --days days (default 7).
//
// Cargo never deletes anything from target/. A Cargo.lock or toolchain change compiles the affected
// part of the graph again under new hashes, and the old copy stays for good: one Tauri bump added
// 2.9 GB to a 6.6 GB tree. Edit-and-rebuild does not grow it — rustc collects its own incremental
// sessions — so this only has to catch whole copies nothing builds any more.
//
// A unit is `.fingerprint/<name>-<hash>` plus every `deps/` and `build/` entry carrying that hash.
// "Read" is the newest atime among its files. APFS and Linux relatime refresh atime on a read once it
// is a day old, so the cut-off is accurate to a day; a unit removed by mistake costs only a rebuild.
//
//   node scripts/dev/prune-rust-target.mjs [--days 7] [--dry-run] [--target <dir>] [--force]
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const days = Number(option("--days", "7"));
if (!Number.isFinite(days) || days < 2) {
  // Below two days the one-day atime granularity could remove what the last build read.
  console.error("prune-rust-target: --days must be a number of at least 2");
  process.exit(2);
}
const dryRun = flag("--dry-run");
const targetDir = resolve(
  option("--target", process.env.CARGO_TARGET_DIR || join(repoRoot, "src-tauri", "target")),
);
const cutoffMs = Date.now() - days * 86_400_000;

const HASH = /-([0-9a-f]{16})(?:\.[^/]*)?$/;
const LOCKS = [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"];

/** Newest file atime and total size under `path`, following no symlinks. A directory's own atime
 *  is skipped: listing it (`du`, Spotlight, this script) refreshes it without any build reading it. */
function scan(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return { atime: st.atimeMs, bytes: st.size };
  let atime = 0;
  let bytes = 0;
  for (const entry of readdirSync(path)) {
    const sub = scan(join(path, entry));
    atime = Math.max(atime, sub.atime);
    bytes += sub.bytes;
  }
  return { atime, bytes };
}

/** true / false, or null when lsof is unavailable and the answer is unknown. */
function heldOpen(profileDir) {
  const present = LOCKS.map((l) => join(profileDir, l)).filter(existsSync);
  if (present.length === 0) return false;
  try {
    return execFileSync("lsof", ["-t", ...present], { encoding: "utf8" }).trim() !== "";
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return false; // lsof exits 1 when no process has the files open
  }
}

/** Every directory Cargo builds a profile into: target/<profile> and target/<triple>/<profile>. */
function profileDirs(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (existsSync(join(dir, ".fingerprint"))) found.push(dir);
    if (depth === 0) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) walk(join(dir, e.name), depth - 1);
    }
  };
  walk(root, 2);
  return found;
}

function pruneProfile(profileDir) {
  const units = new Map(); // hash -> paths
  const add = (path) => {
    const hash = path.match(HASH)?.[1];
    if (!hash) return;
    if (!units.has(hash)) units.set(hash, []);
    units.get(hash).push(path);
  };
  for (const sub of [".fingerprint", "deps", "build", "examples"]) {
    const dir = join(profileDir, sub);
    if (existsSync(dir)) for (const name of readdirSync(dir)) add(join(dir, name));
  }

  // rustc keeps one session per crate directory and drops the rest itself; a directory whose
  // newest session nobody has read since the cut-off belongs to a copy no build makes any more.
  const stale = [];
  const incremental = join(profileDir, "incremental");
  if (existsSync(incremental)) {
    for (const name of readdirSync(incremental)) {
      const path = join(incremental, name);
      const { atime, bytes } = scan(path);
      if (atime < cutoffMs) stale.push({ paths: [path], bytes });
    }
  }

  let tracked = 0;
  let staleUnits = 0;
  for (const paths of units.values()) {
    // A hash seen only outside .fingerprint is not a unit Cargo tracks; leave it alone.
    if (!paths.some((p) => p.includes(`${join(profileDir, ".fingerprint")}/`))) continue;
    tracked += 1;
    let atime = 0;
    let bytes = 0;
    for (const p of paths) {
      const s = scan(p);
      atime = Math.max(atime, s.atime);
      bytes += s.bytes;
    }
    if (atime < cutoffMs) {
      staleUnits += 1;
      stale.push({ paths, bytes });
    }
  }

  // Everything unread means a `noatime` volume or a long break, not a dead copy; emptying the
  // directory would only force a full rebuild, which `cargo clean` does on purpose.
  if (tracked > 0 && staleUnits === tracked && !flag("--force")) {
    return { count: 0, freed: 0, skipped: "every unit looks unread (noatime volume?)" };
  }

  let freed = 0;
  for (const { paths, bytes } of stale) {
    freed += bytes;
    if (!dryRun) for (const p of paths) rmSync(p, { recursive: true, force: true });
  }
  return { count: stale.length, freed };
}

if (!existsSync(targetDir)) {
  console.log(`prune-rust-target: ${targetDir} does not exist, nothing to do`);
  process.exit(0);
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
let total = 0;
for (const profileDir of profileDirs(targetDir)) {
  const held = heldOpen(profileDir);
  if (held === true) {
    console.log(`prune-rust-target: ${profileDir} is in use by a running build, skipped`);
    continue;
  }
  if (held === null && !flag("--force")) {
    console.log(
      `prune-rust-target: lsof not found, so a running build cannot be ruled out; ${profileDir} skipped (--force to prune anyway)`,
    );
    continue;
  }
  const { count, freed, skipped } = pruneProfile(profileDir);
  if (skipped) {
    console.log(`prune-rust-target: ${profileDir}: ${skipped}, skipped (--force to prune anyway)`);
    continue;
  }
  total += freed;
  console.log(
    `prune-rust-target: ${profileDir}: ${count} entries unread for ${days}+ days, ${gb(freed)} ${dryRun ? "would be freed" : "freed"}`,
  );
}
if (dryRun) console.log(`prune-rust-target: dry run, ${gb(total)} in all`);
