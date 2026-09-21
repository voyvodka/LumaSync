/**
 * Installed ahead of `/src/main.tsx` by the `lumasync:mock-boot` Vite plugin,
 * which only exists when `LUMASYNC_MOCK=1`. Both scripts are modules, so they
 * run in document order and everything here is in place before `main.tsx`
 * executes its module-scope bootstrap.
 *
 * The seam differs by runtime, and it is not a preference:
 *
 * - **Browser** (`bun run dev`): no Tauri process, so `window.__TAURI_INTERNALS__`
 *   does not exist and `mockIPC` can create it. This is the only runtime where
 *   the mock is complete — events, window metadata and all.
 * - **`bun run tauri dev`**: Tauri's document-start init script defines
 *   `__TAURI_INTERNALS__` and every member through `Object.defineProperty` with
 *   no flags, so they land `writable: false, configurable: false`. `mockIPC`
 *   throws on its first assignment. Measured, not assumed — see
 *   `docs/architecture/testing-and-verification.md`. Here the module-resolution
 *   shim is the whole mechanism, and passthrough reaches the real backend.
 */

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

/**
 * Read back out of this file by `scripts/verify/mock-not-shipped.mjs`, and
 * logged rather than merely declared so no optimizer can fold it away.
 */
export const MOCK_BUILD_SENTINEL = "LUMASYNC_DEV_MOCK_ACTIVE_DO_NOT_SHIP";

/** `webview.rs` defines this in every real Tauri window; a browser tab has nothing. */
const hasTauriRuntime = "isTauri" in window && window.isTauri === true;

/**
 * Whether passthrough can reach anything. False in the browser, where a control
 * that triggers real backend behaviour has no backend to trigger and must be
 * presented as unavailable rather than quietly doing nothing.
 */
export const MOCK_HAS_REAL_IPC = hasTauriRuntime;

if (!hasTauriRuntime) {
  // The label picks the branch `main.tsx` takes between the app tree, the LED
  // twin overlay and the control popup — surfaces the WDIO harness cannot reach
  // at all, since only the `main` window handle is exposed there.
  const label = new URLSearchParams(window.location.search).get("window") ?? "main";
  mockWindows(label);
  mockIPC(
    async (command) => {
      throw new Error(
        `[LumaSync][mock] "${command}" reached the browser IPC fallback. There is no Rust process here, so it cannot be answered — add a fixture in mock/handlers/.`,
      );
    },
    { shouldMockEvents: true },
  );
}

console.info(
  `[LumaSync][mock] ${MOCK_BUILD_SENTINEL} — runtime=${hasTauriRuntime ? "tauri" : "browser"}, passthrough=${MOCK_HAS_REAL_IPC ? "live" : "unavailable"}`,
);
