// i18n runs with `escapeValue: false`, and `<Trans>` parses its interpolated
// string for component tags, so a value there is markup, not text. Backend text
// (`details`, a bridge's response body, an error message) must never ride one.
// Source-level: every `<Trans values>` key has to be on this list, so a new one
// is a decision rather than an accident.

/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** Values the app computes itself. Nothing here comes from a command's text. */
const SAFE_TRANS_VALUE_KEYS = new Set(["version", "count", "hz"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, out);
    } else if (full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function transValueKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/<Trans\b/g)) {
    // The element ends at a `/>` closing its line, or at `</Trans>`; an inner
    // `<b />` in `components` is followed by ` }}`, not a line break.
    const rest = source.slice(match.index);
    const end = rest.search(/\/>\s*\n|<\/Trans>/);
    const element = end === -1 ? rest : rest.slice(0, end);
    const values = /values=\{\{([\s\S]*?)\}\}/.exec(element);
    if (!values) continue;
    for (const part of values[1].split(",")) {
      const key = part.split(":")[0]?.trim();
      if (key) keys.push(key);
    }
  }
  return keys;
}

describe("<Trans> values", () => {
  const files = walk(resolve(process.cwd(), "src"));

  it("finds the Trans call sites it is guarding", () => {
    const withValues = files.filter((f) => transValueKeys(readFileSync(f, "utf8")).length > 0);
    expect(withValues.length).toBeGreaterThan(0);
  });

  it("interpolate only app-computed values, never backend text", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const key of transValueKeys(readFileSync(file, "utf8"))) {
        if (!SAFE_TRANS_VALUE_KEYS.has(key)) offenders.push(`${file}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
