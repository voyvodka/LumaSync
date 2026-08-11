import { browser, $ } from "@wdio/globals";

/**
 * Diagnostic, not part of the suite (the glob only picks up `*.e2e.ts`).
 * Run with: npx wdio run wdio.conf.ts --spec e2e/specs/latency.probe.ts
 */

async function time(label: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    const value = await fn();
    console.log(`[probe] ${label}: ${Date.now() - started}ms -> ${JSON.stringify(value)}`);
  } catch (error) {
    console.log(`[probe] ${label}: ${Date.now() - started}ms -> THREW ${String(error)}`);
  }
}

describe("bridge capability probe", () => {
  it("measures per-command cost and multi-window reach", async () => {
    await time("execute(1)", () => browser.execute(() => 1));
    await time("$().isExisting", () => $('[data-testid="compact-layout"]').isExisting());
    await time("$().getAttribute", () =>
      $('[data-testid="mode-button-off"]').getAttribute("aria-pressed"),
    );
    await time("$().click", () => $('[data-testid="mode-button-off"]').click());
    await time("getTitle", () => browser.getTitle());
    await time("getWindowHandles", () => browser.getWindowHandles());
  });
});
