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
 * The onboarding banner's *visibility* rules (`onboardingState.ts`:
 * `hasCompletedOnboarding`, `guardsLoaded`, the 3s/8s reveal delay from
 * #415) depend on persisted flags this layer cannot seed or reset without
 * risking someone else's real `shell-state.json` — there is no isolated
 * profile (testing-and-verification.md). A machine that has already
 * finished onboarding, which is most of them, will never show the banner at
 * all, so a spec asserting "it appears" would be unrunnable most of the
 * time, and one asserting "it does not appear" would be trivially true for
 * the wrong reason.
 *
 * What *is* safe and worth asserting without touching that state: if the
 * banner happens to be visible, it satisfies the a11y contract
 * (`OnboardingBanner.tsx`) — a named landmark, and every action inside it
 * has an accessible name. This is read-only: nothing here ever clicks the
 * banner's own dismiss or action buttons, so it never advances or
 * completes onboarding.
 */
describe("onboarding banner (read-only, presence-conditional)", () => {
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

  // The flow can mount a banner on Lights, Devices or LED Setup
  // (OnboardingFlow.tsx's doc comment); the calibration banner is Lights-only.
  const SECTIONS_TO_CHECK: SectionId[] = [
    SECTION_IDS.LIGHTS,
    SECTION_IDS.DEVICES,
    SECTION_IDS.LED_SETUP,
  ];

  for (const section of SECTIONS_TO_CHECK) {
    it(`the ${section} banner, if shown, is a named landmark with named actions`, async () => {
      await switchUiMode("full");
      await clickTestId(`section-tab-${section}`);
      await browser.waitUntil(() => exists(`[data-testid="section-panel-${section}"]`), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `section ${section} never mounted`,
      });
      // The reveal delay is up to 8s (#415); give it room without turning
      // every run into an 8s wait when the banner is simply absent.
      await browser.pause(500);

      if (!(await exists(".lm-onboarding-banner"))) {
        return;
      }

      const report = await browser.execute(() => {
        const banner = document.querySelector(".lm-onboarding-banner");
        if (banner === null) return null;
        const label = banner.getAttribute("aria-label")?.trim() ?? "";
        const actionButtons = Array.from(
          banner.querySelectorAll<HTMLElement>(
            ".lm-onboarding-banner-primary, .lm-onboarding-banner-secondary, .lm-onboarding-banner-dismiss",
          ),
        );
        return {
          hasLabel: label.length > 0,
          unnamedActions: actionButtons.filter(
            (el) => (el.getAttribute("aria-label")?.trim() ?? "").length === 0,
          ).length,
        };
      });

      expect(report?.hasLabel).toBe(true);
      expect(report?.unnamedActions).toBe(0);
    });
  }
});
