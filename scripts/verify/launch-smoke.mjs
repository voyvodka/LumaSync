#!/usr/bin/env node
// Start a built app, assert STARTUP_READY_MARKER, quit. Flags: --binary <path>,
// --log-file <path>, --hard-kill. The default binary needs `pnpm tauri build
// --debug --no-bundle`; plain `cargo build` writes a dev-URL binary there.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIFECYCLE_SRC = path.join(REPO_ROOT, "src", "features", "shell", "windowLifecycle.ts");
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_BINARY = path.join(
  REPO_ROOT,
  "src-tauri",
  "target",
  "debug",
  IS_WINDOWS ? "lumasync.exe" : "lumasync",
);

// Generous but bounded. A cold webview init on a loaded CI runner is the slow
// case; anything past this is a hang, not slowness.
const READY_TIMEOUT_MS = 120_000;
// The Rust shutdown watchdog hard-exits at 4s, so a healthy quit is well inside.
const SHUTDOWN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

const SHUTDOWN_DONE = "[shutdown] cleanup complete, exiting";
const SHUTDOWN_WATCHDOG = "[shutdown] watchdog fired";
// Leaked by a hard exit that bypasses the single-instance plugin's destroy();
// a stale one makes the *next* launch exit silently, so never leave it behind.
const SINGLE_INSTANCE_SOCKET = "/tmp/com_lumasync_app_si.sock";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, detail) {
  console.error(`\nFAIL: ${message}`);
  if (detail !== undefined) {
    console.error("\n--- captured app output ---");
    console.error(detail.trim().length > 0 ? detail : "(the app produced no output at all)");
    console.error("--- end captured output ---");
  }
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { binary: DEFAULT_BINARY, logFile: null, hardKill: IS_WINDOWS };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
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
      case "--hard-kill":
        opts.hardKill = true;
        break;
      default:
        fail(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

/** Single source of truth: read the marker out of the module that emits it. */
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

function removeQuietly(target) {
  try {
    rmSync(target, { force: true });
  } catch (error) {
    console.warn(`[launch-smoke] could not remove ${target}: ${error}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const marker = readStartupMarker();

  if (!existsSync(opts.binary)) {
    fail(`binary not found: ${opts.binary}\n       build it: pnpm tauri build --debug --no-bundle`);
  }
  // A leftover log from an earlier run would match the marker without the app
  // ever having started, so the sink starts empty.
  if (opts.logFile !== null) removeQuietly(opts.logFile);
  if (!IS_WINDOWS) removeQuietly(SINGLE_INSTANCE_SOCKET);

  console.log(`[launch-smoke] launching ${opts.binary}`);
  if (opts.logFile !== null) console.log(`[launch-smoke] also scanning ${opts.logFile}`);
  console.log(`[launch-smoke] waiting for: ${marker}`);

  let stdio = "";
  let closed = null;

  const child = spawn(opts.binary, [], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so the kill below also reaps descendants — the
    // AppImage runtime and WebView2 both put the real app under a helper.
    detached: !IS_WINDOWS,
  });

  child.on("error", (error) => fail(`could not spawn the app: ${error.message}`, stdio));
  const absorb = (chunk) => {
    stdio += chunk.toString();
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  // `close` (not `exit`) so stdout is fully drained before we judge the run.
  child.on("close", (code, signal) => {
    closed = { code, signal };
  });

  const readLog = () => {
    if (opts.logFile === null) return "";
    try {
      return readFileSync(opts.logFile, "utf8");
    } catch {
      return "";
    }
  };
  const everything = () => `${stdio}${readLog()}`;

  const forceKill = () => {
    if (closed !== null) return;
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  // An unhandled throw below must not orphan a GUI process on the runner, where
  // it would hold the display open and poison later steps.
  process.on("exit", forceKill);

  try {
    const startedAt = Date.now();
    while (!everything().includes(marker)) {
      if (closed !== null) {
        fail(
          `the app exited (code=${closed.code}, signal=${closed.signal}) after ` +
            `${Date.now() - startedAt} ms without reaching startup — this is the #115 shape`,
          everything(),
        );
      }
      if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        forceKill();
        fail(`timed out after ${READY_TIMEOUT_MS} ms waiting for: ${marker}`, everything());
      }
      await sleep(POLL_INTERVAL_MS);
    }
    const via = stdio.includes(marker) ? "stdout" : "log file";
    console.log(`[launch-smoke] startup reached in ${Date.now() - startedAt} ms (via ${via})`);

    // SIGINT reaches the debug-only ctrl_c hook and runs the tray-Quit path, so
    // its cleanup lines are assertable. Release builds compile that hook out and
    // a soft kill on Windows is WM_CLOSE, which this app hides to tray instead.
    const shutdownAt = Date.now();
    if (opts.hardKill) forceKill();
    else child.kill("SIGINT");

    while (closed === null) {
      if (Date.now() - shutdownAt > SHUTDOWN_TIMEOUT_MS) {
        forceKill();
        fail(`the app did not exit within ${SHUTDOWN_TIMEOUT_MS} ms of the quit signal`, everything());
      }
      await sleep(POLL_INTERVAL_MS);
    }
    console.log(`[launch-smoke] exited in ${Date.now() - shutdownAt} ms`);

    if (!opts.hardKill) {
      const output = everything();
      if (output.includes(SHUTDOWN_WATCHDOG)) {
        fail(`shutdown hung and the 4 s watchdog force-exited: ${SHUTDOWN_WATCHDOG}`, output);
      }
      if (!output.includes(SHUTDOWN_DONE)) {
        fail(`shutdown never logged: ${SHUTDOWN_DONE}`, output);
      }
      console.log("[launch-smoke] shutdown was orderly (no watchdog)");
    }
  } finally {
    forceKill();
    if (!IS_WINDOWS) removeQuietly(SINGLE_INSTANCE_SOCKET);
  }

  console.log("PASS: the build launches and reaches startup.");
}

await main();
