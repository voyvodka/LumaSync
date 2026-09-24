// The "no supported controller" copy names the chip families by hand, because
// the allowlist lives in Rust. This keeps the two from drifting: every entry's
// chip, as its comment names it, must appear in both languages.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import en from "@/locales/en/device";
import tr from "@/locales/tr/device";

const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/commands/device_connection.rs"), "utf8");

function allowlistChips(): string[] {
  const start = rust.indexOf("const SUPPORTED_USB_DEVICE_ALLOWLIST");
  const block = rust.slice(start, rust.indexOf("];", start));
  return [...block.matchAll(/\(0x[0-9A-Fa-f]+,\s*0x[0-9A-Fa-f]+\),\s*\/\/\s*(\S+)/g)].map((m) => m[1] ?? "");
}

describe("supported chip copy", () => {
  it("reads the allowlist", () => {
    expect(allowlistChips().length).toBeGreaterThanOrEqual(9);
  });

  it.each([
    ["en", en.status.noSupportedBody],
    ["tr", tr.status.noSupportedBody],
  ])("names every allowlisted chip in %s", (_lang, copy) => {
    for (const chip of allowlistChips()) {
      expect(copy, `${chip} missing`).toContain(chip);
    }
  });
});
