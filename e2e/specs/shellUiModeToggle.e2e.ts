import { browser, expect } from "@wdio/globals";

import { SECTION_IDS, SECTION_ORDER } from "../../src/shared/contracts/shell";
import type { SectionId, UIMode } from "../../src/shared/contracts/shell";
import {
  activeSectionTab,
  attribute,
  clickTestId,
  currentUiMode,
  exists,
  switchUiMode,
  waitForAppReady,
} from "../support/shell";

/**
 * Regression coverage for #416: full <-> compact stopped working from one
 * specific section, and nothing caught it because the only toggle spec ran
 * from whichever section `shell.e2e.ts` happened to leave active. The toggle
 * button itself is always mounted (`TitleBar.tsx` renders it outside the
 * `uiMode === "full"` tab-list gate), so a per-section regression has to come
 * from something that section mounted — a stuck `transitionLockRef`, an
 * unmount that throws, a modal left open. Driving the toggle from every tab
 * is the only way to catch that class of bug.
 *
 * Filename sorts after `shell.e2e.ts` deliberately (WDIO/mocha runs spec
 * files in glob order, which is alphabetical here) so `shell.e2e.ts`'s own
 * boot-mode capture always runs first — but this file does not actually
 * depend on that ordering: it captures and restores its own starting UI mode
 * and section, so it is correct run first, last, or alone.
 */
describe("ui mode toggle from every section", () => {
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
      await browser.waitUntil(() => exists(`[data-testid="section-panel-${startSection}"]`), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `could not restore the starting section (${startSection})`,
      });
    }
    await switchUiMode(startUiMode);
  });

  for (const section of SECTION_ORDER) {
    it(`toggles compact <-> full from the ${section} tab`, async () => {
      await switchUiMode("full");
      await clickTestId(`section-tab-${section}`);
      await browser.waitUntil(() => exists(`[data-testid="section-panel-${section}"]`), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `section ${section} never mounted before the toggle`,
      });

      await switchUiMode("compact");
      expect(await currentUiMode()).toBe("compact");
      expect(await exists(".lm-errboundary-root")).toBe(false);

      await switchUiMode("full");
      expect(await currentUiMode()).toBe("full");
      // The section survives the round trip: `activeSection` lives in
      // `App.tsx` state, untouched by the compact/full branch in
      // `SettingsLayout.tsx`, so the same panel should still be mounted.
      expect(await exists(`[data-testid="section-panel-${section}"]`)).toBe(true);
      expect(await activeSectionTab()).toBe(section);
      expect(await exists(".lm-errboundary-root")).toBe(false);
    });
  }

  it("toggles compact <-> full from the Devices section's Hue sub-view", async () => {
    await switchUiMode("full");
    await clickTestId(`section-tab-${SECTION_IDS.DEVICES}`);
    await browser.waitUntil(
      () => exists(`[data-testid="section-panel-${SECTION_IDS.DEVICES}"]`),
      {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: "devices section never mounted",
      },
    );

    // No skip for an unpaired machine: the rail renders every category
    // unconditionally, and an unpaired Hue sub-view is the pairing flow.
    const hueRail = '[data-testid="device-category-hue"]';
    await clickTestId("device-category-hue");
    await browser.waitUntil(async () => (await attribute(hueRail, "aria-current")) === "page", {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: "the Hue category never became the open one",
    });

    await switchUiMode("compact");
    expect(await currentUiMode()).toBe("compact");
    await switchUiMode("full");
    expect(await currentUiMode()).toBe("full");
    expect(await exists(".lm-errboundary-root")).toBe(false);
  });
});
