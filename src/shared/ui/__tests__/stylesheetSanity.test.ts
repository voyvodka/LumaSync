// CSS fails by dropping a declaration or matching nothing, never by erroring,
// so each rule here pins a bug that shipped silently. Source-level: happy-dom
// applies no stylesheet.

/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readStylesheet } from "@/test/stylesheetSource";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, exts, out);
    } else if (exts.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesCss = stripComments(readStylesheet());
const cssFiles = walk(SRC, [".css"]).map((file) => ({
  file,
  css: stripComments(readFileSync(file, "utf8")),
}));

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  return css.slice(start, css.indexOf("}", start));
}

describe("stylesheet sanity", () => {
  it("declares the app dark-only, so native controls render dark", () => {
    expect(ruleBody(stylesCss, ":root")).toMatch(/color-scheme:\s*dark\s*;/);
    // A `prefers-color-scheme` branch follows the OS, not the app, and gave a
    // light-mode OS a light body behind the dark chrome.
    expect(stylesCss).not.toContain("prefers-color-scheme");
  });

  it("paints the body with the app background, not a light gradient", () => {
    const body = ruleBody(stylesCss, "\nbody");
    expect(body).toContain("var(--lm-bg)");
    expect(body).not.toMatch(/linear-gradient|radial-gradient/);
  });

  it("keeps the twin overlay root transparent", () => {
    // The twin is a see-through window over the desktop; any paint here is a
    // full-screen opaque frame.
    const twin = ruleBody(stylesCss, ".lm-twin-root");
    expect(twin).toMatch(/background:\s*transparent\s*;/);
  });

  it("never uses a box-shadow ring token as an outline value", () => {
    // `outline: var(--lm-focus-ring)` is invalid at computed-value time, so the
    // declaration drops and the control has no focus ring at all.
    for (const { file, css } of cssFiles) {
      expect(css, file).not.toMatch(/outline\s*:\s*var\(\s*--lm-focus-ring/);
    }
  });

  it("imports every feature sheet into a cascade layer", () => {
    // An unlayered rule outranks every utility, which is how `.hidden` once
    // needed a per-class override. `@theme` has to stay top-level, so the
    // theme file is the one exception and may hold nothing else.
    const entry = readFileSync(join(SRC, "styles.css"), "utf8");
    const imports = [...entry.matchAll(/^@import\s+"\.\/styles\/([^"]+)"([^;]*);$/gm)];
    const imported = imports.map((m) => m[1]);
    const onDisk = readdirSync(join(SRC, "styles")).filter((f) => f.endsWith(".css"));
    expect(imported.slice().sort()).toEqual(onDisk.slice().sort());
    for (const [, file, rest] of imports) {
      if (file === "theme.css") {
        const theme = stripComments(readFileSync(join(SRC, "styles", file), "utf8"));
        expect(theme.replace(/@theme[^{]*\{[^}]*\}/g, "").trim(), file).toBe("");
      } else {
        expect(rest, `${file} is imported without a layer`).toMatch(/\blayer\((base|components)\)/);
      }
    }
  });

  it("names a selected state `is-on` or reads it from ARIA, never `is-sel`/`is-selected`", () => {
    const retired = /\bis-(sel|selected)\b/;
    const offenders = [
      ...cssFiles.filter(({ css }) => retired.test(css)).map(({ file }) => file),
      ...walk(SRC, [".tsx"]).filter((file) => retired.test(readFileSync(file, "utf8"))),
    ];
    expect(offenders).toEqual([]);
  });

  it("has no selector that repeats a compound back to back", () => {
    const offenders: string[] = [];
    for (const { file, css } of cssFiles) {
      for (const match of css.matchAll(/([^{}@;]+)\{/g)) {
        for (const selector of match[1].split(",")) {
          const compounds = selector.trim().split(/\s+/).filter(Boolean);
          if (compounds.some((c, i) => i > 0 && c === compounds[i - 1] && /^[.#]/.test(c))) {
            offenders.push(`${file}: ${selector.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no Tailwind `dark:` variant, which follows the OS rather than the app", () => {
    const offenders = walk(SRC, [".tsx", ".ts"]).filter((file) =>
      /["'`\s]dark:[a-z]/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
