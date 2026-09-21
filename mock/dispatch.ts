/**
 * The dev mock's dispatcher.
 *
 * Three rules here are load-bearing and none is obvious from the code:
 *
 * - **A fixture never resolves on a microtask.** An instantly-answering mock
 *   hides loading states and every ordering bug behind them. This repo has five
 *   confirmed instances of async work with no latest-operation guard, and
 *   `devdocs/lumasync-roadmap.md:236` records a concurrency test that passed
 *   against unfixed code precisely because a mocked write resolved on a
 *   microtask. The floor is a real macrotask delay.
 * - **An unmapped command fails loudly**, naming itself. Returning `undefined`
 *   is how a new Rust command gets built against garbage for a week.
 * - **A response that lands under a different generation than it was issued
 *   under is reported, not suppressed.** Rejecting it would hide exactly the
 *   bug class above: a call site that accepts a stale answer is a call site
 *   missing a guard.
 */

import { applyForcedCode } from "./handlers/codes";
import { handlerFor, PASSTHROUGH_COMMANDS } from "./handlers";
import { getWorld } from "./state";

export const PASSTHROUGH_SET: ReadonlySet<string> = new Set<string>(PASSTHROUGH_COMMANDS);

/** Tauri routes its own plugin traffic through `invoke` under this prefix. */
const PLUGIN_PREFIX = "plugin:";

/** The lowest delay a fixture may answer in. See the microtask rule above. */
export const MIN_FIXTURE_LATENCY_MS = 120;

/** Commands that are slow in the real app, so a fixture that is fast misleads. */
const SLOW_COMMANDS: Record<string, number> = {
  discover_hue_bridges: 900,
  discover_wled_devices: 1200,
  list_serial_ports: 350,
  run_serial_health_check: 800,
  test_wled_bridge: 1500,
  pair_hue_bridge: 400,
};

export function isPassthrough(command: string): boolean {
  // A plugin command is only passed through when nothing here answers it —
  // `plugin:store|load` gates startup and must be answered in the browser.
  if (command.startsWith(PLUGIN_PREFIX)) {
    return handlerFor(command) === undefined;
  }
  return PASSTHROUGH_SET.has(command);
}

export function hasFixture(command: string): boolean {
  return handlerFor(command) !== undefined;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function latencyFor(command: string): number {
  const base = SLOW_COMMANDS[command] ?? MIN_FIXTURE_LATENCY_MS;
  return base + getWorld().extraLatencyMs;
}

/** Reported through `console.warn` so it reaches the Rust log sink too. */
function reportStale(command: string, issued: number, landed: number, elapsedMs: number): void {
  console.warn(
    `[LumaSync][mock] STALE RESPONSE — "${command}" was issued under generation ${issued} and resolved under generation ${landed} after ${elapsedMs} ms. The caller received data from a scenario that is no longer active. If this call site has no latest-operation guard, the same thing happens in production whenever a real response is overtaken.`,
  );
}

export async function dispatch<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const handler = handlerFor(command);
  if (handler === undefined) {
    throw new Error(
      `[LumaSync][mock] no fixture for "${command}". Add one under mock/handlers/, or list it in PASSTHROUGH_COMMANDS / INTENTIONALLY_UNMAPPED with a reason.`,
    );
  }

  if (getWorld().forcedThrows.includes(command)) {
    await sleep(latencyFor(command));
    throw new Error(
      `[LumaSync][mock] "${command}" rejected because the panel forced it to. This is the IPC-layer failure path, not a coded one — most real failures arrive as a status code inside a successful response.`,
    );
  }

  const issuedGeneration = getWorld().generation;
  const startedAt = Date.now();

  await sleep(latencyFor(command));
  const forcedCode = getWorld().forcedCodes[command];
  const result = (
    forcedCode === undefined ? handler(args) : applyForcedCode(handler(args), forcedCode)
  ) as T;

  const landedGeneration = getWorld().generation;
  if (landedGeneration !== issuedGeneration) {
    reportStale(command, issuedGeneration, landedGeneration, Date.now() - startedAt);
  }

  return result;
}
