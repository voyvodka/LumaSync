/// <reference types="node" />
// The old device cards had a test for this floor; the strip page's hand-rolled controls need their
// own, or the next tweak to a box's height slips under it unnoticed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const stripCss = read("src/features/device/ui/StripPage.module.css");
// The typed field is the device pages' shared one.
const pageCss = read("src/shared/ui/SettingRow/SettingPage.module.css");

function px(selector: string, property: "width" | "height", css = stripCss): number {
  const block = css.match(new RegExp(`\\n  \\.${selector} \\{([^}]*)\\}`))?.[1] ?? "";
  const value = block.match(new RegExp(`(?:^|\\n)\\s*${property}: (\\d+)px;`))?.[1];
  return value === undefined ? Number.NaN : Number(value);
}

describe("strip page tap targets", () => {
  it.each([
    ["rename", "width"],
    ["rename", "height"],
    ["choice", "height"],
    ["nameInput", "height"],
  ] as const)(".%s %s is at least 32 px", (selector, property) => {
    expect(px(selector, property)).toBeGreaterThanOrEqual(32);
  });

  it("the shared address field is at least 32 px tall", () => {
    expect(px("input", "height", pageCss)).toBeGreaterThanOrEqual(32);
  });
});
