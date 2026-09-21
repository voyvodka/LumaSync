import { browser } from "@wdio/globals";
import { mkdirSync, writeFileSync } from "node:fs";

import { SECTION_ORDER } from "../../src/shared/contracts/shell";
import type { SectionId } from "../../src/shared/contracts/shell";
import { clickTestId, exists, switchUiMode, waitForAppReady } from "../support/shell";

/**
 * Diagnostic, not part of the suite — the spec glob only picks up `*.e2e.ts`,
 * so CI never runs this. It asserts almost nothing on purpose: it drives the
 * real window, writes a PNG per screen and a structural report, and leaves the
 * judgement to whoever reads them.
 *
 *   npx wdio run wdio.conf.ts --spec e2e/specs/ui-audit.probe.ts
 *   LUMASYNC_AUDIT_SECTION=devices npx wdio run wdio.conf.ts --spec e2e/specs/ui-audit.probe.ts
 *
 * What it cannot see is in docs/architecture/testing-and-verification.md, and
 * reading that first will save you from trusting an empty result.
 */

const OUT = process.env.LUMASYNC_AUDIT_OUT ?? "/tmp/lumasync-audit";

const requested = process.env.LUMASYNC_AUDIT_SECTION;
const targets: SectionId[] =
  requested === undefined
    ? [...SECTION_ORDER]
    : SECTION_ORDER.filter((section) => section === requested);

interface SectionReport {
  section: SectionId;
  screenshot: string;
  structure: unknown;
  consoleErrors: unknown;
}

const report: { capturedAt: string; sections: SectionReport[]; compact?: unknown } = {
  capturedAt: new Date().toISOString(),
  sections: [],
};

/** Page-level failures only. The IPC boundary is deliberately absent — a hook
 *  installed from here records zero even while the backend is working. */
async function watchConsole(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __auditErrors?: unknown[] };
    if (w.__auditErrors !== undefined) return;
    const errors: unknown[] = [];
    window.addEventListener("error", (e) => errors.push({ kind: "error", message: e.message }));
    window.addEventListener("unhandledrejection", (e) =>
      errors.push({ kind: "rejection", message: String((e as PromiseRejectionEvent).reason).slice(0, 200) }),
    );
    w.__auditErrors = errors;
  });
}

const drainConsole = () =>
  browser.execute(() => {
    const errors = (window as unknown as { __auditErrors: unknown[] }).__auditErrors;
    return errors.splice(0, errors.length);
  });

const structure = (panel: string) =>
  browser.execute((selector: string) => {
    const root = document.querySelector(selector) ?? document.body;
    const controls = Array.from(
      root.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [role="button"], [role="tab"]'),
    );
    const name = (el: HTMLElement) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();

    return {
      controlCount: controls.length,
      // A control a screen reader cannot announce.
      unnamed: controls.filter((el) => name(el).length === 0).map((el) => el.className.toString().slice(0, 48)),
      // A control that looks selected but says so only in CSS.
      selectionInCssOnly: controls
        .filter(
          (el) =>
            /\bis-on\b|\bis-active\b|\bis-selected\b/.test(el.className.toString()) &&
            el.getAttribute("aria-selected") === null &&
            el.getAttribute("aria-pressed") === null &&
            el.getAttribute("aria-current") === null,
        )
        .map((el) => name(el).replace(/\s+/g, " ").slice(0, 40)),
      keyboardUnreachable: controls.filter((el) => el.getAttribute("tabindex") === "-1").length,
      // Text painted outside a box that clips it.
      clipped: Array.from(root.querySelectorAll<HTMLElement>("*"))
        .filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === "hidden")
        .map((el) => el.className.toString().slice(0, 48)),
      errorBoundaryTripped: document.querySelector(".lm-errboundary-root") !== null,
      documentLanguage: document.documentElement.lang,
    };
  }, panel);

describe("ui audit", () => {
  before(async () => {
    mkdirSync(OUT, { recursive: true });
    await waitForAppReady();
    await watchConsole();
  });

  it("captures the compact window", async () => {
    await switchUiMode("compact");
    await browser.saveScreenshot(`${OUT}/compact.png`);
    report.compact = await structure('[data-testid="compact-layout"]');
  });

  it("captures every requested section in full mode", async () => {
    await switchUiMode("full");

    for (const section of targets) {
      await clickTestId(`section-tab-${section}`);
      await browser.waitUntil(async () => exists(`[data-testid="section-panel-${section}"]`), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: `section ${section} never mounted its panel`,
      });
      // Anything the mount kicked off asynchronously lands before the capture.
      await browser.pause(1200);

      const screenshot = `${OUT}/full-${section}.png`;
      await browser.saveScreenshot(screenshot);
      report.sections.push({
        section,
        screenshot,
        structure: await structure(`[data-testid="section-panel-${section}"]`),
        consoleErrors: await drainConsole(),
      });
      console.log(`[audit] ${section} -> ${screenshot}`);
    }

    await switchUiMode("compact");
  });

  after(async () => {
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    console.log(`[audit] report -> ${OUT}/report.json`);
  });
});
