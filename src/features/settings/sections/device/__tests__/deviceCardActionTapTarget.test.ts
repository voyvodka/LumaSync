// Device-card footer buttons measured ~28 px; only the pairing flow's opt-in
// variant met the 32 px floor. The floor now sits on the base class every card
// footer uses. Source-level: happy-dom applies no stylesheet.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const src = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const stylesCss = src("styles.css");

function ruleBody(selector: string): string {
  const start = stylesCss.indexOf(`\n${selector} {`);
  expect(start, `${selector} must be declared`).toBeGreaterThanOrEqual(0);
  const open = stylesCss.indexOf("{", start);
  return stylesCss.slice(open + 1, stylesCss.indexOf("}", open));
}

describe("device card footer actions", () => {
  it("meet the 32 px tap floor on the base class", () => {
    const body = ruleBody(".lm-dcard-act");
    expect(body).toMatch(/min-height:\s*32px;/);
    expect(body).toMatch(/align-items:\s*center;/);
  });

  it("show the amber focus ring on keyboard focus", () => {
    expect(ruleBody(".lm-dcard-act:focus-visible")).toMatch(/box-shadow:\s*var\(--lm-focus-ring\);/);
  });

  it.each([
    "features/settings/sections/device/HueBridgesCategory.tsx",
    "features/settings/sections/device/UsbStripsCategory.tsx",
    "features/settings/sections/WledDevicePicker.tsx",
  ])("%s renders its footer actions with the sized class", (file) => {
    const source = src(file);
    expect(source).toContain('className="lm-dcard-actions"');
    const footers = source.split('className="lm-dcard-actions"').slice(1);
    for (const footer of footers) {
      const firstButton = /<button[\s\S]*?className="([^"]+)"/.exec(footer)?.[1];
      expect(firstButton?.split(" ")).toContain("lm-dcard-act");
    }
  });
});
