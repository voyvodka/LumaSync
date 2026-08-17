import { browser, expect } from "@wdio/globals";

import { SECTION_IDS } from "../../src/shared/contracts/shell";
import { LIGHTING_MODE_KIND } from "../../src/features/mode/model/contracts";
import type { UIMode } from "../../src/shared/contracts/shell";
import {
  attribute,
  clickTestId,
  currentUiMode,
  exists,
  persistedUiMode,
  switchUiMode,
  waitForAppReady,
} from "../support/shell";

const MODE_KINDS = Object.values(LIGHTING_MODE_KIND);
const SECTIONS = Object.values(SECTION_IDS);

describe("app shell", () => {
  // The mode the app came up in, before any spec moves it. Captured rather than
  // asserted: since the boot path restores the persisted mode, whichever one the
  // last run left behind is the correct answer here.
  let bootMode: UIMode;
  let storedAtBoot: UIMode | null;

  before(async () => {
    await waitForAppReady();
    bootMode = await currentUiMode();
    // Read before the switch below rewrites it.
    storedAtBoot = persistedUiMode();
    // Every spec below reads the compact mode strip, and the suite used to get
    // it by luck — a machine whose stored mode was `full` failed the first three
    // and then passed on a re-run, because the last spec leaves compact behind.
    await switchUiMode("compact");
  });

  it("comes up in the mode it was left in", async () => {
    expect(bootMode).toBe(storedAtBoot ?? "compact");
  });

  it("renders the mode strip in compact", async () => {
    expect(await currentUiMode()).toBe("compact");

    for (const kind of MODE_KINDS) {
      expect(await exists(`[data-testid="mode-button-${kind}"]`)).toBe(true);
    }
  });

  it("marks exactly one mode as active", async () => {
    await switchUiMode("compact");

    const pressed = await Promise.all(
      MODE_KINDS.map((kind) =>
        attribute(`[data-testid="mode-button-${kind}"]`, "aria-pressed"),
      ),
    );

    expect(pressed.filter((value) => value === "true")).toHaveLength(1);
  });

  // Off is the one transition driveable on a machine with no LED controller and
  // no bridge; Ambilight and Solid are gated on a reachable output target.
  it("drives the state machine through the Off button", async () => {
    await switchUiMode("compact");
    await clickTestId(`mode-button-${LIGHTING_MODE_KIND.OFF}`);

    await browser.waitUntil(
      async () =>
        (await attribute(
          `[data-testid="mode-button-${LIGHTING_MODE_KIND.OFF}"]`,
          "aria-pressed",
        )) === "true",
      { timeout: 15_000, interval: 100, timeoutMsg: "Off never became active" },
    );
  });

  it("round-trips compact → full → compact", async () => {
    await switchUiMode("full");
    expect(await currentUiMode()).toBe("full");

    await switchUiMode("compact");
    expect(await currentUiMode()).toBe("compact");
  });

  it("routes every settings section in full mode", async () => {
    await switchUiMode("full");

    for (const section of SECTIONS) {
      await clickTestId(`section-tab-${section}`);

      await browser.waitUntil(
        async () => exists(`[data-testid="section-panel-${section}"]`),
        {
          timeout: 15_000,
          interval: 100,
          timeoutMsg: `section ${section} never mounted its panel`,
        },
      );
      expect(await attribute(`[data-testid="section-tab-${section}"]`, "aria-selected")).toBe(
        "true",
      );
    }

    await switchUiMode("compact");
  });

  it("keeps the webview free of unhandled render failures", async () => {
    expect(await exists(".lm-errboundary-root")).toBe(false);
  });
});
