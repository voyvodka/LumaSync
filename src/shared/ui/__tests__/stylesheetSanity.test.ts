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

  it("puts every component stylesheet (CSS Module) wholly inside the components layer", () => {
    // A module is loaded by its component, not through styles.css, so nothing
    // else places it in a layer. Unlayered, its rules would outrank utilities.
    const modules = cssFiles.filter(({ file }) => file.endsWith(".module.css"));
    for (const { file, css } of modules) {
      const body = css.trim();
      expect(body.startsWith("@layer components {"), `${file} does not open with @layer components`).toBe(true);
      // The layer block is the whole file: its closing brace is the last character.
      let depth = 0;
      let closedAt = -1;
      for (let i = body.indexOf("{"); i < body.length; i += 1) {
        if (body[i] === "{") depth += 1;
        else if (body[i] === "}" && --depth === 0) {
          closedAt = i;
          break;
        }
      }
      expect(closedAt, `${file} has rules outside its @layer components block`).toBe(body.length - 1);
    }
  });

  it("keeps plain stylesheets in src/styles; a component's own styles are a CSS Module beside it", () => {
    // Global sheets are the ordered list in styles.css; anything else is scoped to
    // its component. The two exceptions load outside that list on purpose.
    const loose = cssFiles
      .map(({ file }) => file.slice(SRC.length + 1))
      .filter((file) => !file.startsWith("styles/") && !file.endsWith(".module.css"));
    expect(loose.sort()).toEqual(["features/shell/GlobalErrorBoundary.css", "fonts.css", "styles.css"]);
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
