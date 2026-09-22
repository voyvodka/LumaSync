import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { browser } from "@wdio/globals";

import { SHELL_STORE_KEY, type SectionId, type UIMode } from "../../src/shared/contracts/shell";
import { LIGHTING_MODE_KIND } from "../../src/features/mode/model/contracts";

// `browser.execute` only, never `$()`: the embedded provider answers execute
// in-process (~3 ms) but takes 5-22 s per element-protocol call on macOS.
// `e2e/specs/latency.probe.ts` reproduces it.

const COMPACT = '[data-testid="compact-layout"]';
const FULL = '[data-testid="full-layout"]';

export async function waitForAppReady(): Promise<void> {
  await browser.waitUntil(
    async () =>
      exists(
        `[data-testid="mode-button-${LIGHTING_MODE_KIND.OFF}"], [data-testid="section-tab-lights"]`,
      ),
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: "app shell never rendered a mode strip or a section tab",
    },
  );
  await withPaintDiagnostic("waitForAppReady", () => settleTransition());
}

export async function exists(selector: string): Promise<boolean> {
  return browser.execute(
    (query: string) => document.querySelector(query) !== null,
    selector,
  );
}

export async function attribute(selector: string, name: string): Promise<string | null> {
  return browser.execute(
    (query: string, attr: string) =>
      document.querySelector(query)?.getAttribute(attr) ?? null,
    selector,
    name,
  );
}

export async function currentUiMode(): Promise<UIMode> {
  return (await exists(COMPACT)) ? "compact" : "full";
}

export async function clickTestId(testId: string): Promise<void> {
  const clicked = await browser.execute((query: string) => {
    const element = document.querySelector<HTMLElement>(query);
    if (element === null) {
      return false;
    }
    element.click();
    return true;
  }, `[data-testid="${testId}"]`);

  if (!clicked) {
    throw new Error(`no element with data-testid="${testId}"`);
  }
}

/** `useUIMode` drops a switch requested mid-transition (`transitionLockRef`),
 * so every switch settles before it returns. */
export async function switchUiMode(target: UIMode): Promise<void> {
  if ((await currentUiMode()) === target) {
    return;
  }

  await clickTestId("ui-mode-toggle");

  await withPaintDiagnostic(`switchUiMode(${target})`, async () => {
    await browser.waitUntil(async () => (await currentUiMode()) === target, {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `UI mode did not settle on ${target}`,
    });
    await settleTransition();
  });
}

/**
 * True when the OS believes this window cannot currently paint — occluded,
 * minimized, or (observed against a real machine) the screen is locked.
 * `useUIMode.ts`'s fade/resize chain depends on that: `resizeToMode` drives a
 * native window-resize animation, and the fade-in step is gated on an
 * un-timed-out double `requestAnimationFrame` (`nextDoublePaint`) — the one
 * step in that chain with no safety timeout. Neither can ever complete while
 * the window is not actually painting, so `switchUiMode` hangs to its own
 * 30s timeout and reports a generic "did not settle" — true, but not the
 * reason.
 *
 * Read via `document.visibilityState`, the cheap synchronous signal: a
 * `requestAnimationFrame`-based probe would observe the actual symptom more
 * directly, but needs the `execute` script to await a Promise, which this
 * project's custom `embedded` WebDriver executor (`platform/executor.rs`)
 * has not been confirmed to support — see `latency.probe.ts` for the kind of
 * surprise that executor has produced before.
 */
export async function windowLikelyUnpaintable(): Promise<boolean> {
  return browser.execute(() => document.visibilityState !== "visible");
}

/** Wraps a transition step so a failure caused by an unpaintable window says
 *  so, instead of surfacing only the generic "did not settle" WDIO timeout. */
async function withPaintDiagnostic<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (await windowLikelyUnpaintable()) {
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${context}: the window is not paintable right now ` +
          `(document.visibilityState !== "visible") — most likely a locked screen, or the window ` +
          "is occluded/minimized. useUIMode's fade/resize chain cannot finish without real paint " +
          "cycles. This is not a spec bug: unlock the screen (or bring the window to the front) " +
          `and re-run. Original error: ${original}`,
      );
    }
    throw error;
  }
}

/** True once every ancestor of the active layout is back at full opacity —
 * the last step of the fade-out → resize → fade-in chain. */
async function settleTransition(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (compact: string, full: string) => {
          let node = document.querySelector(`${compact}, ${full}`);
          if (node === null) {
            return false;
          }
          while (node !== null) {
            if (getComputedStyle(node).opacity !== "1") {
              return false;
            }
            node = node.parentElement;
          }
          return true;
        },
        COMPACT,
        FULL,
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "UI mode transition never settled at full opacity",
    },
  );
}

export async function isDisabled(selector: string): Promise<boolean> {
  return browser.execute((query: string) => {
    const el = document.querySelector<HTMLButtonElement>(query);
    return el === null ? true : el.disabled;
  }, selector);
}

/** The lighting-mode kind whose `[data-testid="mode-button-<kind>"]` currently
 *  carries `aria-pressed="true"`, or `null` if the compact mode strip is not
 *  mounted (i.e. the app is in full mode) or nothing is pressed yet. */
export async function activeModeKind(): Promise<string | null> {
  return browser.execute(() => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="mode-button-"]'),
    );
    const active = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    return active?.getAttribute("data-testid")?.replace("mode-button-", "") ?? null;
  });
}

/** The section whose `[data-testid="section-tab-<id>"]` currently carries
 *  `aria-selected="true"`, or `null` outside full mode (the tabs do not
 *  mount in compact — `TitleBar.tsx`). */
export async function activeSectionTab(): Promise<SectionId | null> {
  return browser.execute(() => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="section-tab-"]'));
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    return (active?.getAttribute("data-testid")?.replace("section-tab-", "") ?? null) as
      | SectionId
      | null;
  });
}

/**
 * True only when the StatusBar's HUE pill (`statusItems.ts`, always mounted
 * regardless of section or UI mode) reads anything other than `is-off` —
 * i.e. a bridge is paired, whether or not it is currently reachable.
 *
 * Read structurally rather than through a `data-testid`: the pill has none,
 * and this file intentionally avoids adding one to Hue-adjacent product code
 * while other work is in flight there (see the spec files that use this).
 * The label text "HUE" and the `is-<kind>` class are hardcoded, non-i18n
 * strings (`buildStatusItems` in `statusItems.ts`), so this is stable across
 * locales.
 */
export async function hueConfigured(): Promise<boolean> {
  return browser.execute(() => {
    const pairs = Array.from(document.querySelectorAll(".lm-statusbar-pair"));
    const huePair = pairs.find(
      (el) => el.querySelector(".lm-statusbar-label")?.textContent?.trim() === "HUE",
    );
    const value = huePair?.querySelector(".lm-statusbar-value");
    return value !== null && value !== undefined && !value.classList.contains("is-off");
  });
}

/**
 * Installs a page-level `error`/`unhandledrejection` listener once per
 * session. Deliberately does not touch the IPC boundary — a hook installed
 * there records zero while the backend works (testing-and-verification.md).
 * Mirrors `ui-audit.probe.ts`'s `watchConsole`, under a different `window`
 * key so the two never collide if ever run back to back.
 */
export async function installErrorWatcher(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __specErrors?: unknown[] };
    if (w.__specErrors !== undefined) return;
    const errors: unknown[] = [];
    window.addEventListener("error", (e) => errors.push({ kind: "error", message: e.message }));
    window.addEventListener("unhandledrejection", (e) =>
      errors.push({ kind: "rejection", message: String((e as PromiseRejectionEvent).reason).slice(0, 200) }),
    );
    w.__specErrors = errors;
  });
}

/** Drains and returns whatever `installErrorWatcher` has captured since the
 *  last drain, so each section gets its own clean window. */
export async function drainErrors(): Promise<unknown[]> {
  return browser.execute(() => {
    const w = window as unknown as { __specErrors?: unknown[] };
    const errors = w.__specErrors ?? [];
    return errors.splice(0, errors.length);
  });
}

/** Where `plugin-store` puts `shell-state.json` for `com.lumasync.app`. */
function shellStatePath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "com.lumasync.app", `${SHELL_STORE_KEY}.json`);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "com.lumasync.app", `${SHELL_STORE_KEY}.json`);
  }
  return join(home, ".local", "share", "com.lumasync.app", `${SHELL_STORE_KEY}.json`);
}

/** The stored UI mode, or `null` on a machine that has never run the app — which
 *  is every CI runner, and the reason a spec must not hard-code either answer.
 *  Read from disk rather than the webview: the store is not on `window`. */
export function persistedUiMode(): UIMode | null {
  try {
    const raw = JSON.parse(readFileSync(shellStatePath(), "utf-8")) as Record<string, unknown>;
    const state = (raw[SHELL_STORE_KEY] ?? raw) as { uiMode?: UIMode };
    return state.uiMode ?? null;
  } catch {
    return null;
  }
}
