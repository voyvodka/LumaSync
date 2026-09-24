import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { browser } from "@wdio/globals";

import { SHELL_STORE_KEY, type SectionId, type ShellState, type UIMode } from "../../src/shared/contracts/shell";
import { LIGHTING_MODE_KIND } from "../../src/shared/contracts/mode";

// `browser.execute` only, never `$()`: the embedded provider answers execute
// in-process (~3 ms) but takes 5-22 s per element-protocol call on macOS.
// `e2e/specs/latency.probe.ts` reproduces it.

const COMPACT = '[data-testid="compact-layout"]';
const FULL = '[data-testid="full-layout"]';

/** `UpdateModal` renders `role="dialog"` + `aria-modal="true"`; the last
 *  selector catches a future modal that forgets its role. */
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

export interface OpenDialog {
  role: string;
  modal: boolean;
  /** Accessible name, from `aria-label` or the `aria-labelledby` target. */
  label: string;
  /** Visible text, whitespace-collapsed and truncated. */
  text: string;
}

/**
 * Every dialog currently rendered with a box. A JS `click()` reaches a control
 * behind a modal that a user could never reach, so a spec that navigates under
 * one reports success on a screen nobody can use.
 */
export async function openDialogs(): Promise<OpenDialog[]> {
  return browser.execute((selector: string) => {
    const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const labelledBy = el.getAttribute("aria-labelledby");
        const labelSource = labelledBy === null ? null : document.getElementById(labelledBy);
        return {
          role: el.getAttribute("role") ?? "(none)",
          modal: el.getAttribute("aria-modal") === "true",
          label: collapse(el.getAttribute("aria-label") ?? labelSource?.textContent ?? ""),
          text: collapse(el.innerText || el.textContent || "").slice(0, 300),
        };
      });
  }, DIALOG_SELECTOR);
}

/** Fails when a dialog is open that the calling step did not open itself. */
export async function assertNoOpenDialog(context: string): Promise<void> {
  const dialogs = await openDialogs();
  if (dialogs.length === 0) return;
  const described = dialogs
    .map((d) => `${d.role}${d.modal ? " (modal)" : ""} "${d.label}": ${d.text}`)
    .join(" | ");
  throw new Error(`${context}: unexpected dialog open over the app — ${described}`);
}

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
  await assertNoOpenDialog("waitForAppReady");
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
  await assertNoOpenDialog(`clickTestId(${testId})`);
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

/** How long one toggle click gets to land before this retries it. Short on
 *  purpose — #423 bounded every animation-frame wait in the transition chain
 *  at 250 ms, so a click that actually lands settles well inside this. */
const TOGGLE_SETTLE_TIMEOUT_MS = 1_500;
/** A few, not many: each retry is a fresh click, and `currentUiMode() ===
 *  target` is checked first, so a click that already landed costs nothing. */
const MAX_TOGGLE_ATTEMPTS = 4;

/**
 * `useUIMode` drops a switch requested mid-transition (`transitionLockRef`),
 * so every switch settles before it returns.
 *
 * Since #423, `transitionLockRef` is always eventually released — but
 * strictly *after* the final paint wait, which (while the window is hidden
 * or occluded) can trail the DOM's mode-testid swap, and this helper's own
 * opacity read, by up to that same ~250 ms. A toggle click that lands inside
 * that window is dropped by design (`useUIMode.ts`'s re-entrancy guard), not
 * queued. Treating one dropped click as a hang is what produced "UI mode did
 * not settle on full" immediately after a *successful* switch to compact:
 * the lock from the compact switch was still draining when the next click
 * fired. So this retries the click a few times instead of failing on the
 * first miss, each attempt re-checking `currentUiMode()` first so a click
 * that did land makes every further attempt a no-op.
 */
export async function switchUiMode(target: UIMode): Promise<void> {
  await assertNoOpenDialog(`switchUiMode(${target})`);
  if ((await currentUiMode()) === target) {
    return;
  }

  await withPaintDiagnostic(`switchUiMode(${target})`, async () => {
    for (let attempt = 1; attempt <= MAX_TOGGLE_ATTEMPTS; attempt++) {
      if ((await currentUiMode()) === target) break;

      await clickTestId("ui-mode-toggle");

      try {
        await browser.waitUntil(async () => (await currentUiMode()) === target, {
          timeout: TOGGLE_SETTLE_TIMEOUT_MS,
          interval: 100,
          timeoutMsg: `UI mode did not settle on ${target} (attempt ${attempt}/${MAX_TOGGLE_ATTEMPTS})`,
        });
        break;
      } catch (error) {
        // Most likely a dropped click (`transitionLockRef` still held from
        // the previous switch) — retry rather than give up on one miss.
        if (attempt === MAX_TOGGLE_ATTEMPTS) throw error;
      }
    }
    await settleTransition();
  });
}

/**
 * True when the OS believes this window cannot currently paint — occluded,
 * minimized, or (observed against a real machine) the screen is locked.
 * Before #423 this was fatal to every transition (`useUIMode.ts`'s fade/
 * resize chain awaited `requestAnimationFrame` with no bound, so it never
 * completed while unpainted); #423 put a 250 ms ceiling on every such wait,
 * so a transient lock is now normally absorbed by `switchUiMode`'s own
 * retries above. Seeing this diagnostic fire means the window was *still*
 * unpaintable after exhausting those retries — e.g. the screen has been
 * locked for the whole retry window, not just a transient occlusion.
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
        `${context}: the window is still not paintable ` +
          `(document.visibilityState !== "visible") after retrying — most likely the screen has ` +
          "been locked (or the window occluded/minimized) for the whole retry window, not just a " +
          "transient dip that #423's 250ms frame-wait ceiling would normally absorb. This is not a " +
          `spec bug: unlock the screen (or bring the window to the front) and re-run. Original ` +
          `error: ${original}`,
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
 *  carries `aria-checked="true"`, or `null` if the compact mode strip is not
 *  mounted (i.e. the app is in full mode) or nothing is checked yet. */
export async function activeModeKind(): Promise<string | null> {
  return browser.execute(() => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="mode-button-"]'),
    );
    const active = buttons.find((b) => b.getAttribute("aria-checked") === "true");
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
 * `status-chip-HUE` is keyed by the chip's label, a hardcoded non-i18n
 * string (`buildStatusItems` in `statusItems.ts`), as is the `is-<kind>`
 * class, so this is stable across locales.
 */
export async function hueConfigured(): Promise<boolean> {
  return browser.execute(() => {
    const value = document.querySelector('[data-testid="status-chip-HUE"] .lm-statusbar-value');
    return value !== null && !value.classList.contains("is-off");
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

/** Where `shell-state.json` lives for `com.lumasync.app`. */
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

function persistedShellState(): Partial<ShellState> | null {
  try {
    const raw = JSON.parse(readFileSync(shellStatePath(), "utf-8")) as Record<string, unknown>;
    return (raw[SHELL_STORE_KEY] ?? raw) as Partial<ShellState>;
  } catch {
    return null;
  }
}

/** The stored UI mode, or `null` on a machine that has never run the app — which
 *  is every CI runner, and the reason a spec must not hard-code either answer.
 *  Read from disk rather than the webview: the store is not on `window`. */
export function persistedUiMode(): UIMode | null {
  return persistedShellState()?.uiMode ?? null;
}

/** The stored "Show stats for nerds" choice; absent, like a never-run machine,
 *  is `false` — the same reading the app gives it. */
export function persistedShowNerdStats(): boolean {
  return persistedShellState()?.showNerdStats === true;
}
