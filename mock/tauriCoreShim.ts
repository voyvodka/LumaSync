/**
 * The alias target. `vite.config.ts` redirects every resolved import of
 * `@tauri-apps/api/core.js` here when `LUMASYNC_MOCK=1`, which catches both the
 * sibling api modules (`./core.js`, relative) and the six plugin packages
 * (`@tauri-apps/api/core`, bare).
 *
 * Only `invoke` is replaced. Everything else is re-exported verbatim, so a
 * consumer that reaches for `Channel` or `convertFileSrc` gets the real thing.
 *
 * Known gap, currently harmless: `addPluginListener`, `checkPermissions` and
 * `requestPermissions` are implemented *inside* the real `core.js` and close over
 * its module-local `invoke`, so they bypass this shim. None of the three appears
 * anywhere in `src/` today, and `scripts/verify/mock-not-shipped.mjs` fails the
 * build if one shows up — a silent half-mock is worse than no mock.
 */

export {
  Channel,
  PluginListener,
  Resource,
  SERIALIZE_TO_IPC_FN,
  addPluginListener,
  checkPermissions,
  convertFileSrc,
  isTauri,
  requestPermissions,
  transformCallback,
} from "@tauri-apps/api/core";

import { invoke as realInvoke } from "@tauri-apps/api/core";

import { dispatch, hasFixture, isPassthrough } from "./dispatch";

/**
 * Under `bun run tauri dev` the passthrough reaches Rust. In the browser it
 * reaches whatever `mockIPC` installed on `__TAURI_INTERNALS__`. The shim does
 * not need to know which, and deliberately does not check.
 */
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: unknown,
): Promise<T> {
  if (isPassthrough(command) || !hasFixture(command)) {
    return realInvoke<T>(command, args, options as never);
  }
  return dispatch<T>(command, args);
}
