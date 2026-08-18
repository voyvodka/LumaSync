#!/usr/bin/env node
// Windows-only R29 probe. Flags: --mode <default|transparent|transparent+layered|off>,
// --out <dir>, --binary <path>, --log-file <path> (scanned from its size at launch,
// never deleted), --gate (fail unless the
// overlay painted its edge band and both hit-test points fell through it).
// See docs/architecture/build-and-release.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIFECYCLE_SRC = path.join(REPO_ROOT, "src", "features", "shell", "windowLifecycle.ts");
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "verify", "win-overlay-probe.ps1");
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_BINARY = path.join(REPO_ROOT, "src-tauri", "target", "debug", "lumasync.exe");
const DEFAULT_LOG_FILE = path.join(
  process.env.LOCALAPPDATA ?? "",
  "com.lumasync.app",
  "logs",
  "lumasync-dev.log",
);

const READY_TIMEOUT_MS =
  Number.parseInt(process.env.OVERLAY_SMOKE_READY_TIMEOUT_MS ?? "", 10) || 120_000;
const OVERLAY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
// Long enough for WebView2 to reach first paint and for the 2500 ms re-sweep
// tail in calibration.rs to have run.
const PAINT_SETTLE_MS = 3_000;
const BASELINE_SETTLE_MS = 1_500;

const MODES = new Set(["default", "transparent", "transparent+layered", "off"]);
const OPENED_RE =
  /\[smoke-overlay\] opened label=(\S+) display=(.*?) outer=(-?\d+),(-?\d+) (\d+)x(\d+) scale=([0-9.]+)/;
// The tray "Close Overlays" rescue, measured after the probe has taken its
// evidence — an overlay that cannot be torn down is the half of R29 the pixel
// diff says nothing about. `--gate` covers this too: it fails unless the
// teardown left nothing visible and put the main window back.
const RESCUED_RE = /\[smoke-overlay\] rescued overlays=(\d+) main_visible=(true|false)/;
const RESCUE_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, detail) {
  console.error(`\n[overlay-smoke] FAIL: ${message}`);
  if (detail !== undefined && detail.trim().length > 0) {
    console.error("\n--- captured app output ---");
    console.error(detail);
    console.error("--- end captured output ---");
  }
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    mode: "default",
    out: path.join(REPO_ROOT, "overlay-smoke"),
    binary: DEFAULT_BINARY,
    logFile: DEFAULT_LOG_FILE,
    gate: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--mode":
        if (value === undefined || !MODES.has(value)) {
          fail(`--mode needs one of: ${[...MODES].join(", ")}`);
        }
        opts.mode = value;
        i += 1;
        break;
      case "--out":
        if (value === undefined) fail("--out needs a directory");
        opts.out = path.resolve(value);
        i += 1;
        break;
      case "--binary":
        if (value === undefined) fail("--binary needs a path");
        opts.binary = path.resolve(value);
        i += 1;
        break;
      case "--log-file":
        if (value === undefined) fail("--log-file needs a path");
        opts.logFile = path.resolve(value);
        i += 1;
        break;
      case "--gate":
        opts.gate = true;
        break;
      default:
        fail(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

/** Duplicated from launch-smoke rather than shared: that script gates every
 * release on three platforms and must not move for a probe's benefit. */
function readStartupMarker() {
  if (!existsSync(LIFECYCLE_SRC)) {
    fail(`cannot read the startup marker — ${LIFECYCLE_SRC} is missing`);
  }
  const match = /STARTUP_READY_MARKER\s*=\s*"([^"]+)"/.exec(readFileSync(LIFECYCLE_SRC, "utf8"));
  if (match === null) {
    fail(`no \`STARTUP_READY_MARKER = "..."\` declaration in ${LIFECYCLE_SRC}`);
  }
  return match[1];
}

// Same footgun as launch-smoke: `cargo build` overwrites this path with a
// dev-URL binary that launches, stays alive and logs nothing.
function assertFrontendIsEmbedded(binary) {
  let indexHtml;
  try {
    indexHtml = readFileSync(path.join(REPO_ROOT, "dist", "index.html"), "utf8");
  } catch {
    return;
  }
  const asset = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(indexHtml);
  if (asset === null) return;
  if (!readFileSync(binary).includes(asset[0])) {
    fail(
      `${binary} does not embed ${asset[0]}: this is a dev-URL build, not a\n` +
        "       `tauri build --debug --no-bundle` one, and would time out silently",
    );
  }
}

function sizeQuietly(target) {
  try {
    return statSync(target).size;
  } catch {
    return 0;
  }
}

function removeQuietly(target) {
  try {
    rmSync(target, { force: true });
  } catch (error) {
    console.warn(`[overlay-smoke] could not remove ${target}: ${error}`);
  }
}

function runProbe(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PROBE_SCRIPT, ...args],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, detail: `could not spawn powershell.exe: ${result.error.message}` };
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    return { ok: false, detail: `win-overlay-probe.ps1 exited with ${result.status}` };
  }
  return { ok: true };
}

function readJsonQuietly(file) {
  try {
    // PowerShell 5.1 loves a BOM; JSON.parse does not.
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!IS_WINDOWS) {
    console.log(`[overlay-smoke] unsupported platform: ${process.platform} — nothing to measure`);
    process.exit(0);
  }

  const marker = readStartupMarker();
  mkdirSync(opts.out, { recursive: true });

  if (!existsSync(opts.binary)) {
    fail(`binary not found: ${opts.binary}\n       build it: pnpm tauri build --debug --no-bundle`);
  }
  if (opts.binary === DEFAULT_BINARY) assertFrontendIsEmbedded(opts.binary);
  if (!existsSync(PROBE_SCRIPT)) fail(`probe script not found: ${PROBE_SCRIPT}`);

  // Only what the app appends after this point counts — same rule as
  // launch-smoke, and for the same reason: never delete a developer's live log.
  const logStart = sizeQuietly(opts.logFile);

  const triggerFile = path.join(opts.out, "overlay-trigger");
  // Named by the app as `<trigger>.close`, not configured separately: one path
  // cannot get out of step with itself.
  const closeTriggerFile = `${triggerFile}.close`;
  removeQuietly(triggerFile);
  removeQuietly(closeTriggerFile);

  const childEnv = {
    ...process.env,
    LUMASYNC_NO_DEVTOOLS: "1",
    LUMASYNC_SMOKE_OVERLAY_TRIGGER: triggerFile,
  };
  // "default" means: leave the variable unset, so the app takes its own default.
  if (opts.mode === "default") delete childEnv.LUMASYNC_WIN_OVERLAY_SWEEP;
  else childEnv.LUMASYNC_WIN_OVERLAY_SWEEP = opts.mode;

  console.log(`[overlay-smoke] mode=${opts.mode} out=${opts.out}`);
  console.log(`[overlay-smoke] launching ${opts.binary}`);
  console.log(`[overlay-smoke] scanning ${opts.logFile}`);

  let stdio = "";
  let closed = null;

  const child = spawn(opts.binary, [], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  child.on("error", (error) => fail(`could not spawn the app: ${error.message}`, stdio));
  const absorb = (chunk) => {
    stdio += chunk.toString();
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("close", (code, signal) => {
    closed = { code, signal };
  });

  const readLog = () => {
    try {
      const bytes = readFileSync(opts.logFile);
      return bytes.subarray(bytes.length < logStart ? 0 : logStart).toString("utf8");
    } catch {
      return "";
    }
  };
  const everything = () => `${stdio}${readLog()}`;

  const forceKill = () => {
    if (closed !== null) return;
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  };
  process.on("exit", forceKill);

  const dumpEvidence = () => {
    const output = everything();
    writeFileSync(path.join(opts.out, "app-output.log"), output, "utf8");
    const interesting = output
      .split(/\r?\n/)
      .filter((line) => line.includes("[overlay-sweep]") || line.includes("[smoke-overlay]"));
    writeFileSync(path.join(opts.out, "sweep-log.txt"), `${interesting.join("\n")}\n`, "utf8");
    console.log("\n--- overlay sweep + smoke log lines ---");
    for (const line of interesting) console.log(line);
    console.log("--- end sweep log ---\n");
    return output;
  };

  try {
    const startedAt = Date.now();
    while (!everything().includes(marker)) {
      if (closed !== null) {
        dumpEvidence();
        fail(
          `the app exited (code=${closed.code}, signal=${closed.signal}) after ` +
            `${Date.now() - startedAt} ms without reaching startup`,
          everything(),
        );
      }
      if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        dumpEvidence();
        forceKill();
        fail(`timed out after ${READY_TIMEOUT_MS} ms waiting for: ${marker}`, everything());
      }
      await sleep(POLL_INTERVAL_MS);
    }
    console.log(`[overlay-smoke] startup reached in ${Date.now() - startedAt} ms`);

    await sleep(BASELINE_SETTLE_MS);
    const baselineRun = runProbe(["-BaselineOnly", "-Mode", opts.mode, "-Out", opts.out]);
    if (!baselineRun.ok) {
      dumpEvidence();
      forceKill();
      fail(`baseline capture failed: ${baselineRun.detail}`);
    }
    const baseline = readJsonQuietly(path.join(opts.out, "baseline.json"));
    if (baseline === null) {
      dumpEvidence();
      forceKill();
      fail(`baseline.json was not written into ${opts.out}`);
    }
    // A black baseline makes "the overlay painted nothing" unfalsifiable.
    if (typeof baseline.nonBlackPct === "number" && baseline.nonBlackPct <= 0.01) {
      console.warn("[overlay-smoke] baseline is near-solid black — treat the pixel diff as unusable");
    }

    console.log(`[overlay-smoke] tripping the trigger: ${triggerFile}`);
    writeFileSync(triggerFile, "go\n", "utf8");

    const triggeredAt = Date.now();
    let opened = OPENED_RE.exec(everything());
    while (opened === null) {
      if (closed !== null) {
        dumpEvidence();
        fail(
          `the app exited (code=${closed.code}, signal=${closed.signal}) while opening the overlay`,
          everything(),
        );
      }
      if (Date.now() - triggeredAt > OVERLAY_TIMEOUT_MS) {
        dumpEvidence();
        forceKill();
        fail(
          `timed out after ${OVERLAY_TIMEOUT_MS} ms waiting for '[smoke-overlay] opened' — ` +
            "either the open failed or the main thread is wedged",
          everything(),
        );
      }
      await sleep(POLL_INTERVAL_MS);
      opened = OPENED_RE.exec(everything());
    }

    const rect = {
      label: opened[1],
      display: opened[2],
      x: Number.parseInt(opened[3], 10),
      y: Number.parseInt(opened[4], 10),
      width: Number.parseInt(opened[5], 10),
      height: Number.parseInt(opened[6], 10),
      scale: Number.parseFloat(opened[7]),
    };
    console.log(
      `[overlay-smoke] overlay opened in ${Date.now() - triggeredAt} ms at ` +
        `${rect.x},${rect.y} ${rect.width}x${rect.height} (display=${rect.display})`,
    );

    await sleep(PAINT_SETTLE_MS);

    const probeRun = runProbe([
      "-ProcessId",
      String(child.pid),
      "-X",
      String(rect.x),
      "-Y",
      String(rect.y),
      "-Width",
      String(rect.width),
      "-Height",
      String(rect.height),
      "-Baseline",
      path.join(opts.out, "baseline.png"),
      "-BaselineX",
      String(baseline.x ?? 0),
      "-BaselineY",
      String(baseline.y ?? 0),
      "-Mode",
      opts.mode,
      "-Out",
      opts.out,
    ]);

    dumpEvidence();

    if (!probeRun.ok) {
      forceKill();
      fail(`probe failed: ${probeRun.detail}`);
    }

    const probe = readJsonQuietly(path.join(opts.out, "probe.json"));
    if (probe === null) {
      forceKill();
      fail(`probe.json was not written into ${opts.out}`);
    }

    const verdict = probe.verdict ?? {};
    const bandPct = verdict.bandChangedPct ?? "n/a";
    const innerPct = verdict.innerChangedPct ?? "n/a";
    const clickthrough =
      verdict.pointHitsOverlay?.centre === false && verdict.pointHitsOverlay?.topBand === false;
    const layeredChildren = verdict.childrenWithLayered ?? "n/a";
    console.log(
      `[overlay-smoke] mode=${opts.mode} painted=${bandPct}% inner=${innerPct}% ` +
        `clickthrough=${clickthrough} layeredChildren=${layeredChildren}`,
    );
    console.log(`[overlay-smoke] artefacts in ${opts.out}`);

    console.log(`[overlay-smoke] tripping the close trigger: ${closeTriggerFile}`);
    writeFileSync(closeTriggerFile, "close\n", "utf8");

    const rescueAt = Date.now();
    let rescued = RESCUED_RE.exec(everything());
    while (rescued === null && closed === null && Date.now() - rescueAt <= RESCUE_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      rescued = RESCUED_RE.exec(everything());
    }
    if (rescued === null) {
      // Not a failure on its own — the non-gate modes exist to gather evidence
      // about a deliberately broken overlay, and a missing line is evidence.
      // `--gate` turns it into one below.
      console.warn(
        `[overlay-smoke] no '[smoke-overlay] rescued' line within ${RESCUE_TIMEOUT_MS} ms — ` +
          (closed === null
            ? "close_all_overlays never returned, which is a wedged main thread"
            : `the app exited (code=${closed.code}, signal=${closed.signal}) first`),
      );
    } else {
      console.log(
        `[overlay-smoke] rescue in ${Date.now() - rescueAt} ms: overlays=${rescued[1]} ` +
          `main_visible=${rescued[2]}`,
      );
    }

    dumpEvidence();

    if (opts.gate) {
      // Thresholds from the first CI runs (2026-08-18): a healthy overlay changed
      // ~5% of the edge band and ~0.2% of the interior; the <=1.5.5 sweep turned
      // the whole display solid black (69% / 33%). Anything between is a defect
      // of a kind we have not seen, and it should fail rather than pass quietly.
      const problems = [];
      if (!(Number(bandPct) >= 1)) problems.push(`edge band changed ${bandPct}% (< 1%): nothing painted`);
      if (!(Number(innerPct) <= 10))
        problems.push(`interior changed ${innerPct}% (> 10%): the overlay is not transparent`);
      if (!clickthrough) problems.push("a hit-test point resolved to the overlay: not click-through");
      // The tray rescue is the last way out of a wedged overlay; a survivor, a
      // hidden main window, or no answer at all means there is none.
      if (rescued === null) problems.push("the tray rescue never reported back");
      else {
        if (rescued[1] !== "0") problems.push(`${rescued[1]} overlay(s) survived the tray rescue`);
        if (rescued[2] !== "true") problems.push("the main window is not visible after the rescue");
      }
      if (problems.length > 0) {
        forceKill();
        fail(`overlay gate failed: ${problems.join("; ")}`);
      }
    }
  } finally {
    forceKill();
    // A survivor would make the next mode's launch hit the single-instance
    // plugin and exit silently, which reads as a startup timeout.
    for (let i = 0; closed === null && i < 40; i += 1) await sleep(POLL_INTERVAL_MS);
  }

  process.exit(0);
}

await main();
