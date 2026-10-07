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
// macOS and Linux only: the running-build check needs lsof.
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
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`prune-rust-target: ${name} needs a value`);
    process.exit(2);
  }
  return value;
};

const days = Number(option("--days", "7"));
if (!Number.isFinite(days) || days < 2) {
  // Below two days the one-day atime granularity could remove what the last build read.
  console.error("prune-rust-target: --days must be a number of at least 2");
  process.exit(2);
}
const dryRun = flag("--dry-run");
const force = flag("--force");
const targetDir = resolve(
  option("--target", process.env.CARGO_TARGET_DIR || join(repoRoot, "src-tauri", "target")),
);
const cutoffMs = Date.now() - days * 86_400_000;

const HASH = /-([0-9a-f]{16})(?:\.[^/\\]*)?$/;
const LOCKS = [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"];
// A file read well after it was written; on a noatime volume no file ever shows this.
const READ_AFTER_WRITE_MS = 60_000;

/** Newest file atime, total size, and whether any file was read after it was written, under
 *  `path`, following no symlinks. A directory's own atime is skipped: listing it (`du`, Spotlight,
 *  this script) refreshes it without any build reading it. */
function scan(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) {
    return {
      atime: st.atimeMs,
      bytes: st.size,
      readAfterWrite: st.atimeMs > st.mtimeMs + READ_AFTER_WRITE_MS,
    };
  }
  let atime = 0;
  let bytes = 0;
  let readAfterWrite = false;
  for (const entry of readdirSync(path)) {
    const sub = scan(join(path, entry));
    atime = Math.max(atime, sub.atime);
    bytes += sub.bytes;
    readAfterWrite ||= sub.readAfterWrite;
  }
  return { atime, bytes, readAfterWrite };
}

/** true / false, or null when it cannot be told (no lsof, or lsof failed). */
function heldOpen(profileDir) {
  const present = LOCKS.map((l) => join(profileDir, l)).filter(existsSync);
  if (present.length === 0) return false;
  try {
    return (
      execFileSync("lsof", ["-t", ...present], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() !== ""
    );
  } catch (error) {
    // lsof exits 1 both when nothing holds the files and on an error; only the silent 1 is "free".
    if (error.status === 1 && !`${error.stdout}${error.stderr}`.trim()) return false;
    return null;
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
  const units = new Map(); // hash -> { paths, tracked }
  for (const sub of [".fingerprint", "deps", "build", "examples"]) {
    const dir = join(profileDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const hash = name.match(HASH)?.[1];
      if (!hash) continue;
      if (!units.has(hash)) units.set(hash, { paths: [], tracked: false });
      const unit = units.get(hash);
      // .fingerprint first, so an interrupted prune leaves Cargo a missing fingerprint — a rebuild.
      if (sub === ".fingerprint") {
        unit.tracked = true;
        unit.paths.unshift(join(dir, name));
      } else {
        unit.paths.push(join(dir, name));
      }
    }
  }

  const stale = [];
  let tracked = 0;
  let staleUnits = 0;
  let atimeWorks = false;
  for (const { paths, tracked: isTracked } of units.values()) {
    // A hash seen only outside .fingerprint is not a unit Cargo tracks; leave it alone.
    if (!isTracked) continue;
    tracked += 1;
    let atime = 0;
    let bytes = 0;
    for (const p of paths) {
      const s = scan(p);
      atime = Math.max(atime, s.atime);
      bytes += s.bytes;
      atimeWorks ||= s.readAfterWrite;
    }
    if (atime < cutoffMs) {
      staleUnits += 1;
      stale.push({ paths, bytes });
    }
  }

  // rustc keeps one session per crate directory and drops the rest itself; a directory whose
  // newest session nobody has read since the cut-off belongs to a copy no build makes any more.
  const incremental = join(profileDir, "incremental");
  if (existsSync(incremental)) {
    for (const name of readdirSync(incremental)) {
      const path = join(incremental, name);
      const { atime, bytes } = scan(path);
      if (atime < cutoffMs) stale.push({ paths: [path], bytes });
    }
  }

  // Without reads moving atime, "unread for a week" means only "built over a week ago", and live
  // dependencies would go with the dead ones. Everything unread at once is a long break, not a dead
  // copy; emptying the directory is what `cargo clean` is for.
  if (!force && tracked > 0 && !atimeWorks) {
    return { skipped: "no file shows a read after its write, so access times look frozen (noatime?)" };
  }
  if (!force && tracked > 0 && staleUnits === tracked) {
    return { skipped: "every unit looks unread" };
  }

  const heldNow = dryRun ? false : heldOpen(profileDir);
  if (heldNow === true || (heldNow === null && !force)) {
    return { skipped: "a build started while scanning" };
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
  if (held === null && !force) {
    console.log(
      `prune-rust-target: cannot tell whether a build is running (lsof missing or failed); ${profileDir} skipped (--force to prune anyway)`,
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
    `prune-rust-target: ${profileDir}: ${count} entries unread for ${days}+ days, about ${gb(freed)} ${dryRun ? "would be freed" : "freed"}`,
  );
}
if (dryRun) console.log(`prune-rust-target: dry run, about ${gb(total)} in all`);
