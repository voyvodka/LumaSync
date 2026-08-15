// A scrim over the title bar leaves the window undraggable and unclosable —
// that bar is the drag region. Source-level: jsdom applies no stylesheet.

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `?raw` on a .css file returns Tailwind's processed output, not the source.
const src = (path: string) => readFileSync(resolve(process.cwd(), "src", path), "utf8");
const stylesCss = src("styles.css");
const titleBarSource = src("features/shell/TitleBar.tsx");
const calibrationPageSource = src("features/calibration/ui/CalibrationPage.tsx");
const updateModalSource = src("features/updater/UpdateModal.tsx");

describe("modal scrim layering", () => {
  it("keeps both scrims below the title bar", () => {
    const css = stylesCss;
    for (const selector of [".lm-updater-backdrop", ".lm-modal-scrim"]) {
      const block = css.slice(css.indexOf(`${selector} {`));
      const inset = /inset:\s*([^;]+);/.exec(block.slice(0, block.indexOf("}")))?.[1];
      expect(inset, `${selector} must declare an inset`).toBeDefined();
      expect(inset, `${selector} must clear the title bar`).toContain("var(--lm-titlebar-h)");
    }
  });

  it("pins the scrim offset to the title bar's real height", () => {
    const declared = /--lm-titlebar-h:\s*(\d+)px/.exec(stylesCss)?.[1];
    const source = /TITLE_BAR_HEIGHT_PX = (\d+)/.exec(titleBarSource)?.[1];
    expect(declared).toBe(source);
  });

  it("does not let either modal root fall back to a full-viewport inset", () => {
    expect(calibrationPageSource).not.toContain(
      "fixed inset-0 z-[60]",
    );
    expect(updateModalSource).not.toContain("inset-0");
  });
});
