// A scrim over the title bar leaves the window undraggable and unclosable —
// that bar is the drag region. Source-level: happy-dom applies no stylesheet.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readStylesheet } from "@/test/stylesheetSource";

// `?raw` on a .css file returns Tailwind's processed output, not the source.
const src = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const stylesCss = readStylesheet();
const titleBarSource = src("features/shell/TitleBar.tsx");
const updateModalSource = src("features/updater/UpdateModal.tsx");
const updateModalCss = src("features/updater/UpdateModal.module.css");
const confirmDialogCss = src("shared/ui/ConfirmDialog/ConfirmDialog.module.css");

describe("modal scrim layering", () => {
  it("keeps both scrims below the title bar", () => {
    for (const [css, selector] of [
      [updateModalCss, ".scrim"],
      [confirmDialogCss, ".scrim"],
    ] as const) {
      const block = css.slice(css.indexOf(`${selector} {`));
      const inset = /inset:\s*([^;]+);/.exec(block.slice(0, block.indexOf("}")))?.[1];
      expect(inset, `${selector} must declare an inset`).toBeDefined();
      expect(inset, `${selector} must clear the title bar`).toContain("var(--lm-titlebar-h)");
    }
  });

  it("pins the scrim offset to the title bar's real height", () => {
    // The bar keeps its height on screen at any interface size, so the offset carries the chrome scale.
    const declared = /--lm-titlebar-h:\s*calc\((\d+)px \* var\(--lm-chrome-scale, 1\)\)/.exec(stylesCss)?.[1];
    const source = /TITLE_BAR_HEIGHT_PX = (\d+)/.exec(titleBarSource)?.[1];
    expect(declared).toBe(source);
  });

  it("does not let the update modal root fall back to a full-viewport inset", () => {
    expect(updateModalSource).not.toContain("inset-0");
  });
});
