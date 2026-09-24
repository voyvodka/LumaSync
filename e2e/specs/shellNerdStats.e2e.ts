import { browser, expect } from "@wdio/globals";

import { SECTION_IDS, type SectionId, type UIMode } from "../../src/shared/contracts/shell";
import {
  activeSectionTab,
  attribute,
  clickTestId,
  currentUiMode,
  exists,
  persistedShowNerdStats,
  switchUiMode,
  waitForAppReady,
} from "../support/shell";

const BAR = '[data-testid="status-bar"]';
const FPS = '[data-testid="status-fps"]';
const FPS_VALUE = '[data-testid="status-fps-value"]';
const CAP = '[data-testid="status-chip-CAP"]';
const HUE = '[data-testid="status-chip-HUE"]';
/** The local-output chip names the bound transport: USB, or WLED when one is bound. */
const LOCAL = '[data-testid="status-chip-USB"], [data-testid="status-chip-WLED"]';
const TOGGLE_ID = "nerd-stats-toggle";
const TOGGLE = `[data-testid="${TOGGLE_ID}"]`;

/** What the status bar says it is showing — the setting as the running UI holds it. */
async function barShowsNerdStats(): Promise<boolean> {
  return (await attribute(BAR, "data-nerd-stats")) === "on";
}

async function waitForBar(on: boolean, context: string): Promise<void> {
  await browser.waitUntil(async () => (await barShowsNerdStats()) === on, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: `${context}: the status bar never showed stats for nerds ${on ? "on" : "off"}`,
  });
}

async function openGeneral(): Promise<void> {
  await switchUiMode("full");
  await clickTestId(`section-tab-${SECTION_IDS.SYSTEM}`);
  // The section is lazy, so its panel can mount before the row does.
  await browser.waitUntil(async () => exists(TOGGLE), {
    timeout: 15_000,
    interval: 100,
    timeoutMsg: "the General section never rendered the stats-for-nerds toggle",
  });
}

/** Clicks the toggle only when it is not already where `on` wants it. */
async function setNerdStats(on: boolean): Promise<void> {
  await openGeneral();
  if ((await attribute(TOGGLE, "aria-checked")) !== String(on)) {
    await clickTestId(TOGGLE_ID);
  }
  await browser.waitUntil(async () => (await attribute(TOGGLE, "aria-checked")) === String(on), {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: `the toggle never read aria-checked=${on}`,
  });
  await waitForBar(on, `setNerdStats(${on})`);
  // The save is what makes it survive; the optimistic flip alone would not.
  await browser.waitUntil(async () => persistedShowNerdStats() === on, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: `shell-state.json never recorded showNerdStats=${on}`,
  });
}

async function expectChipsOnly(context: string): Promise<void> {
  expect(await exists(BAR)).toBe(true);
  expect(await exists(HUE)).toBe(true);
  expect(await exists(LOCAL)).toBe(true);
  // Absent, not hidden: an unmounted pill is what stops its poll.
  if (await exists(FPS)) throw new Error(`${context}: the FPS pill is mounted with stats for nerds off`);
  if (await exists(CAP)) throw new Error(`${context}: the CAP chip is shown with stats for nerds off`);
}

/**
 * Settings → General "Show stats for nerds". Off, the status bar shows the
 * chips alone; on, CAP and the FPS pill come back; the choice is saved and
 * survives a compact ↔ full round trip.
 *
 * What this cannot see: that the telemetry poll actually stopped. An IPC hook
 * installed from a spec records zero while the backend works
 * (`testing-and-verification.md`), so the poll is proven in vitest, where the
 * command bridge is counted (`StatusBar.nerdStats.test.tsx`). Here the proxy
 * is the pill being unmounted rather than hidden.
 *
 * Shares the real `shell-state.json`: the starting value is read from disk and
 * put back in `after`, along with the starting UI mode and section.
 */
describe("stats for nerds", () => {
  let startUiMode: UIMode;
  let startSection: SectionId | null;
  let startNerdStats: boolean;

  before(async () => {
    await waitForAppReady();
    startNerdStats = persistedShowNerdStats();
    startUiMode = await currentUiMode();
    await switchUiMode("full");
    startSection = await activeSectionTab();
    // The status bar reads the stored value asynchronously after boot.
    await waitForBar(startNerdStats, "before");
  });

  after(async () => {
    await setNerdStats(startNerdStats);
    if (startSection !== null) {
      await clickTestId(`section-tab-${startSection}`);
      await browser.waitUntil(() => exists(`[data-testid="section-panel-${startSection}"]`), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `could not restore the starting section (${startSection})`,
      });
    }
    await switchUiMode(startUiMode);
  });

  it("shows only the status chips while off", async () => {
    await setNerdStats(false);

    await expectChipsOnly("off");
  });

  it("brings back CAP and the FPS pill when turned on", async () => {
    await setNerdStats(true);

    expect(await exists(CAP)).toBe(true);
    expect(await exists(FPS)).toBe(true);

    // A live number needs frames flowing, which this spec does not start (no
    // capture permission prompt, no stream to a real device). With a mode
    // already running the pill must turn numeric within a few seconds; with
    // none it must hold the inactive placeholder rather than a stale or zero value.
    let value = "";
    try {
      await browser.waitUntil(
        async () => {
          value = (await browser.execute(
            (query: string) => document.querySelector(query)?.textContent?.trim() ?? "",
            FPS_VALUE,
          )) as string;
          return /^\d+$/.test(value);
        },
        { timeout: 5_000, interval: 250 },
      );
      expect(Number(value)).toBeGreaterThan(0);
    } catch {
      expect(value).toBe("—");
      console.info("[stats for nerds] no frames flowing on this machine; checked the placeholder only");
    }
  });

  it("keeps the choice across a compact ↔ full round trip", async () => {
    await setNerdStats(true);
    await switchUiMode("compact");
    await waitForBar(true, "compact, on");
    expect(await exists(FPS)).toBe(true);
    await switchUiMode("full");
    await waitForBar(true, "full, on");
  });

  it("hides the metrics again when turned off, and stays off across a mode switch", async () => {
    await setNerdStats(false);
    await expectChipsOnly("turned off");

    await switchUiMode("compact");
    await waitForBar(false, "compact, off");
    await expectChipsOnly("compact, off");

    await switchUiMode("full");
    await waitForBar(false, "full, off");
    await expectChipsOnly("full, off");
    expect(persistedShowNerdStats()).toBe(false);
    await openGeneral();
    expect(await attribute(TOGGLE, "aria-checked")).toBe("false");
  });
});
