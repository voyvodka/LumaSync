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

import { dispatch, hasFixture } from "./dispatch";
import { DEFAULT_SCENARIO, SCENARIOS, SCENARIO_IDS, type ScenarioId } from "./scenarios";
import { MOCK_HAS_REAL_IPC } from "./runtime";
import { restoreWorld, setWorld } from "./state";

/**
 * Read back out of this file by `scripts/verify/mock-not-shipped.mjs`, and
 * logged rather than merely declared so no optimizer can fold it away.
 */
export const MOCK_BUILD_SENTINEL = "LUMASYNC_DEV_MOCK_ACTIVE_DO_NOT_SHIP";

const hasTauriRuntime = MOCK_HAS_REAL_IPC;

function requestedScenario(): ScenarioId {
  const asked = new URLSearchParams(window.location.search).get("scenario");
  return SCENARIO_IDS.includes(asked as ScenarioId) ? (asked as ScenarioId) : DEFAULT_SCENARIO;
}

const scenario = requestedScenario();
// A scenario in the query string always wins: it is how the panel applies one.
// Otherwise a world composed by hand survives the reload.
const askedExplicitly = new URLSearchParams(window.location.search).has("scenario");
const restored = askedExplicitly ? null : restoreWorld();
setWorld(restored ?? SCENARIOS[scenario].build(), { keepGeneration: restored !== null });

if (!hasTauriRuntime) {
  // The label picks the branch `main.tsx` takes between the app tree, the LED
  // twin overlay and the control popup — surfaces the WDIO harness cannot reach
  // at all, since only the `main` window handle is exposed there.
  const label = new URLSearchParams(window.location.search).get("window") ?? "main";
  mockWindows(label);
  // Without a Rust process there is nothing behind passthrough, so anything the
  // fixture table does not answer has to fail here rather than hang.
  mockIPC(async (command, payload) => {
    if (!hasFixture(command)) {
      throw new Error(
        `[LumaSync][mock] "${command}" has no fixture and there is no Rust process to pass it to. Add a fixture under mock/handlers/, or run it under \`bun run tauri:mock\` where passthrough works.`,
      );
    }
    return dispatch(command, payload as Record<string, unknown> | undefined);
  }, { shouldMockEvents: true });
}

console.info(
  `[LumaSync][mock] ${MOCK_BUILD_SENTINEL} — runtime=${hasTauriRuntime ? "tauri" : "browser"}, scenario=${scenario}, passthrough=${MOCK_HAS_REAL_IPC ? "live" : "unavailable"}`,
);

/**
 * The panel gets its own React root appended to `<body>`, outside the app's
 * tree entirely. That keeps `src/` free of any reference to `mock/` — the
 * structural half of the ship-safety guarantee — and means a render crash in
 * the app cannot take the panel down with it, which is exactly when a
 * scenario switch is most wanted.
 *
 * A scenario change reloads with the id in the query string rather than
 * re-keying a component, because re-keying would mean editing `App.tsx` and
 * naming the mock from `src/`. Shift-click skips the reload and swaps the
 * fixtures under the running app, which is the mode that surfaces a response
 * landing after its scenario is gone.
 */
async function mountPanel(): Promise<void> {
  const [{ createRoot }, { DevPanel }, React] = await Promise.all([
    import("react-dom/client"),
    import("./ui/DevPanel"),
    import("react"),
  ]);
  const host = document.createElement("div");
  host.id = "lumasync-dev-mock-panel";
  document.body.appendChild(host);
  createRoot(host).render(
    React.createElement(DevPanel, {
      onReloadApp: (id: string) => {
        const url = new URL(window.location.href);
        url.searchParams.set("scenario", id);
        window.location.href = url.toString();
      },
    }),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void mountPanel());
} else {
  void mountPanel();
}
