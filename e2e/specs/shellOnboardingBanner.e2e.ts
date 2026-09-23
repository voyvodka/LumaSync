import { browser, expect } from "@wdio/globals";

import { SECTION_IDS } from "../../src/shared/contracts/shell";
import type { SectionId, UIMode } from "../../src/shared/contracts/shell";
import {
  activeSectionTab,
  clickTestId,
  currentUiMode,
  exists,
  switchUiMode,
  waitForAppReady,
} from "../support/shell";

/**
 * Onboarding now speaks through the shell's notice slot
 * (`src/features/shell/notices/`), beside every other notice; the Lights page
 * keeps its in-page banners (no reachable output, calibration required).
 * Whether either shows depends on persisted flags this layer cannot seed or
 * reset without risking someone else's real `shell-state.json` — there is no
 * isolated profile (testing-and-verification.md). A machine that has
 * already finished onboarding, which is most of them, may show neither, so a
 * spec asserting "it appears" would be unrunnable most of the time, and one
 * asserting "it does not appear" would be trivially true for the wrong reason.
 *
 * What *is* safe and worth asserting without touching that state: whatever
 * happens to be visible satisfies the a11y contract — a named landmark, and
 * every button inside it has an accessible name. This is read-only: nothing
 * here ever clicks a dismiss or an action, so it never advances or completes
 * onboarding.
 */
describe("notice slot and in-page banners (read-only, presence-conditional)", () => {
  let startUiMode: UIMode;
  let startSection: SectionId | null;

  before(async () => {
    await waitForAppReady();
    startUiMode = await currentUiMode();
    await switchUiMode("full");
    startSection = await activeSectionTab();
  });

  after(async () => {
    if (startSection !== null) {
      await clickTestId(`section-tab-${startSection}`);
    }
    await switchUiMode(startUiMode);
  });

  // The slot follows every section; the in-page banners are Lights-only.
  const SECTIONS_TO_CHECK: SectionId[] = [
    SECTION_IDS.LIGHTS,
    SECTION_IDS.DEVICES,
    SECTION_IDS.LED_SETUP,
  ];

  for (const section of SECTIONS_TO_CHECK) {
    it(`on ${section}, any notice or banner shown is a named landmark with named buttons`, async () => {
      await switchUiMode("full");
      await clickTestId(`section-tab-${section}`);
      await browser.waitUntil(() => exists(`[data-testid="section-panel-${section}"]`), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `section ${section} never mounted`,
      });
      // The reveal delay is up to 8s (#415); give it room without turning
      // every run into an 8s wait when nothing is shown.
      await browser.pause(500);

      const selector = '[data-testid="shell-notice-slot"], .lm-onboarding-banner';
      if (!(await exists(selector))) {
        return;
      }

      const reports = await browser.execute((sel: string) => {
        return Array.from(document.querySelectorAll(sel)).map((surface) => {
          const label = surface.getAttribute("aria-label")?.trim() ?? "";
          const buttons = Array.from(surface.querySelectorAll<HTMLElement>("button"));
          return {
            hasLabel: label.length > 0,
            unnamedButtons: buttons.filter(
              (el) => (el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "").length === 0,
            ).length,
          };
        });
      }, selector);

      for (const report of reports) {
        expect(report.hasLabel).toBe(true);
        expect(report.unnamedButtons).toBe(0);
      }
    });
  }
});
