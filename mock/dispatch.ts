/**
 * The dev mock's command table.
 *
 * Stage 1 ships the dispatcher and the rules around it; the fixtures themselves
 * arrive in stage 2. Until then every command falls through to the real IPC, so
 * running with `LUMASYNC_MOCK=1` under `bun run tauri dev` behaves exactly like
 * a normal dev session while the seam itself is being proven.
 *
 * Read `docs/architecture/dev-mock.md` before adding to this file. Two rules
 * there are load-bearing and neither is obvious from the code:
 *
 * - **A fixture never resolves on a microtask.** An instantly-answering mock
 *   hides loading states and every ordering bug behind them; this repo has five
 *   confirmed instances of async work with no latest-operation guard, and an
 *   instant mock would have hidden all five.
 * - **An unmapped command fails loudly.** Returning `undefined` for a command
 *   nobody wrote a fixture for is how a new Rust command gets built against
 *   garbage for a week.
 */

import { HUE_DEBUG_COMMANDS } from "../src/shared/contracts/hue";

/**
 * Commands that reach the real backend even while everything else is mocked.
 *
 * `simulate_hue_fault` is the case that defines the rule: its debug arm fires
 * the shutdown signal on a live DTLS stream so the real reconnect monitor runs.
 * A fixture could return `HUE_FAULT_SIMULATED` and prove nothing — it would make
 * the one control with genuine backend consequences the fakest thing in the app.
 *
 * Passthrough only exists where a real backend does. In the browser there is no
 * Rust process, so these must be presented as unavailable rather than silently
 * answered — see `MOCK_HAS_REAL_IPC`.
 */
export const PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set<string>([
  HUE_DEBUG_COMMANDS.SIMULATE_FAULT,
]);

/** Tauri routes its own plugin traffic through `invoke` under this prefix. */
const PLUGIN_PREFIX = "plugin:";

/** The lowest delay a fixture may answer in. See the microtask rule above. */
export const MIN_FIXTURE_LATENCY_MS = 40;

export function isPassthrough(command: string): boolean {
  return PASSTHROUGH_COMMANDS.has(command) || command.startsWith(PLUGIN_PREFIX);
}

/**
 * Stage 1 has no fixture table, so nothing is mapped yet and every command is
 * handled by the caller's passthrough branch. Stage 2 replaces the body; the
 * signature is what the shim is written against.
 */
export function hasFixture(_command: string): boolean {
  return false;
}

export async function dispatch<T>(command: string, _args?: unknown): Promise<T> {
  throw new Error(
    `[LumaSync][mock] no fixture for "${command}". Add one in mock/handlers/, or add the command to PASSTHROUGH_COMMANDS if it must reach the real backend.`,
  );
}
