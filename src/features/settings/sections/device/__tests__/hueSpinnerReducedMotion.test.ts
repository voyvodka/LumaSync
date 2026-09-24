// The Hue link-button spinner had a Reduce Motion guard in updater.css, which
// the build cascades before devices.css — so the spinner's own `animation`
// shorthand, later in the same layer, reset the duration and the guard never
// applied. Source-level: happy-dom applies no stylesheet.

import { describe, expect, it } from "vitest";

import { readStylesheet } from "@/test/stylesheetSource";

const css = readStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** Index just past the `{` of every reduced-motion block, with its body. */
function reducedMotionBlocks(): Array<{ at: number; body: string }> {
  const blocks: Array<{ at: number; body: string }> = [];
  const opener = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (let match = opener.exec(css); match; match = opener.exec(css)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push({ at: start, body: css.slice(start, i - 1) });
  }
  return blocks;
}

describe.each([".lm-hue-wait-sp", ".lm-hue-retry-sp"])("%s under Reduce Motion", (selector) => {
  it("is calmed by a guard that comes after its own animation rule", () => {
    const base = css.lastIndexOf(`\n${selector} {`);
    expect(base, `${selector} must be declared`).toBeGreaterThanOrEqual(0);
    expect(css.slice(base, css.indexOf("}", base))).toMatch(/animation:\s*lm-spin/);

    const named = new RegExp(`${selector.replace(".", "\\.")}(?![\\w-])`);
    const guard = reducedMotionBlocks().find(
      ({ at, body }) => at > base && named.test(body) && /animation(-duration)?\s*:/.test(body),
    );
    expect(guard, `no reduced-motion rule for ${selector} after its base rule`).toBeDefined();
  });
});
