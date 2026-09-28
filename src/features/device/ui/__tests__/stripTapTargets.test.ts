/// <reference types="node" />
// The old device cards had a test for this floor; the strip page's hand-rolled controls need their
// own, or the next tweak to a box's height slips under it unnoticed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/features/device/ui/StripPage.module.css"), "utf8");

function px(selector: string, property: "width" | "height"): number {
  const block = css.match(new RegExp(`\\n  \\.${selector} \\{([^}]*)\\}`))?.[1] ?? "";
  const value = block.match(new RegExp(`(?:^|\\n)\\s*${property}: (\\d+)px;`))?.[1];
  return value === undefined ? Number.NaN : Number(value);
}

describe("strip page tap targets", () => {
  it.each([
    ["rename", "width"],
    ["rename", "height"],
    ["choice", "height"],
    ["input", "height"],
  ] as const)(".%s %s is at least 32 px", (selector, property) => {
    expect(px(selector, property)).toBeGreaterThanOrEqual(32);
  });
});
