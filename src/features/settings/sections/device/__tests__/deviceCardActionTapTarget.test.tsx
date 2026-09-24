// Device-card footer buttons measured ~28 px; only the pairing flow's opt-in
// variant met the 32 px floor. The floor now sits on the base class every card
// footer uses. Source-level: happy-dom applies no stylesheet.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/shared/ui/Button";

import { readStylesheet } from "@/test/stylesheetSource";

const src = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const stylesCss = readStylesheet();

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
    "features/settings/sections/device/UsbPortCards.tsx",
    "features/settings/sections/WledDevicePicker.tsx",
  ])("%s renders its footer actions with the sized class", (file) => {
    const source = src(file);
    expect(source).toContain('className="lm-dcard-actions"');
    const footers = source.split('className="lm-dcard-actions"').slice(1);
    for (const footer of footers) {
      // `<Button size="card">` renders the same class (pinned below).
      const first = /<(button|Button)\b([\s\S]*?)>/.exec(footer);
      const sized =
        first?.[1] === "Button"
          ? /\bsize="card"/.test(first[2])
          : /className="([^"]*\blm-dcard-act\b[^"]*)"/.test(first?.[2] ?? "");
      expect(sized, `first footer control: ${first?.[0].slice(0, 80)}`).toBe(true);
    }
  });

  it("<Button size=\"card\"> is the footer class", () => {
    render(<Button size="card">x</Button>);
    expect(screen.getByRole("button")).toHaveClass("lm-dcard-act");
    expect(screen.getByRole("button")).not.toHaveClass("lm-btn");
  });
});
