// PR #215 re-planted this idiom verbatim behind a "preserved for test
// compatibility" comment that was false — nothing asserted on those classes.
// This is the assertion that makes the claim true, so the next replant fails.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const src = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");

/** The raw palette the pre-Rev 07 banners used, bypassing the token layer. */
const RAW_BANNER_CLASSES = [
  "emerald-900/20",
  "rose-900/20",
  "emerald-500/40",
  "rose-500/40",
];

const CONVERTED = [
  "features/settings/sections/device/UsbStripsCategory.tsx",
  "features/settings/sections/WledDevicePicker.tsx",
];

describe("status banner convention", () => {
  it("leaves no raw banner palette in the files that carried it", () => {
    for (const file of CONVERTED) {
      const source = src(file);
      for (const raw of RAW_BANNER_CLASSES) {
        expect(source, `${file} still carries ${raw}`).not.toContain(raw);
      }
    }
  });

  it("routes every converted banner through the shared class", () => {
    for (const file of CONVERTED) {
      expect(src(file)).toContain("lm-status-banner");
    }
  });

  it("defines a tone for each state the banners use", () => {
    const css = src("styles.css");
    for (const tone of ["is-ok", "is-warn", "is-err", "is-info"]) {
      expect(css, `.lm-status-banner.${tone} is missing`).toContain(
        `.lm-status-banner.${tone}`,
      );
    }
  });

  it("keeps the shared banner legible under forced colors", () => {
    const css = src("styles.css");
    const block = css.slice(css.indexOf(".lm-status-banner {"));
    expect(block.slice(0, block.indexOf(".lm-chmap-feedback {"))).toContain(
      "forced-colors: active",
    );
  });
});
