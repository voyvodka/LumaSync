import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { browser } from "@wdio/globals";

import { SHELL_STORE_KEY, type UIMode } from "../../src/shared/contracts/shell";
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
  await settleTransition();
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

  await browser.waitUntil(async () => (await currentUiMode()) === target, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `UI mode did not settle on ${target}`,
  });
  await settleTransition();
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
