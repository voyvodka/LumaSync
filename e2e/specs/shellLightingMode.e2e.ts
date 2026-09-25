import { browser, expect } from "@wdio/globals";

import type { UIMode } from "../../src/shared/contracts/shell";
import { LIGHTING_MODE_KIND } from "../../src/shared/contracts/mode";
import {
  activeModeKind,
  attribute,
  clickTestId,
  currentUiMode,
  hueConfigured,
  isDisabled,
  switchUiMode,
  waitForAppReady,
} from "../support/shell";

const MODE_KINDS = Object.values(LIGHTING_MODE_KIND);

async function waitForModePressed(kind: string): Promise<void> {
  await browser.waitUntil(
    async () => (await attribute(`[data-testid="mode-button-${kind}"]`, "aria-checked")) === "true",
    { timeout: 15_000, interval: 100, timeoutMsg: `${kind} never became active` },
  );
}

async function expectExactlyOnePressed(): Promise<void> {
  const pressed = await Promise.all(
    MODE_KINDS.map((kind) => attribute(`[data-testid="mode-button-${kind}"]`, "aria-checked")),
  );
  expect(pressed.filter((value) => value === "true")).toHaveLength(1);
}

/**
 * Off/Ambilight/Solid driven through the mode strip and read back through
 * `aria-checked` — the UI's own reflection of the lighting runtime snapshot,
 * and the only avenue available here: the IPC boundary cannot be hooked from
 * a spec (`testing-and-verification.md`). The mode strip only carries
 * `data-testid`s in compact mode (`ModeStrip.tsx`); the equivalent full-mode
 * buttons in `LightsSection.tsx` have none, so this spec drives compact.
 *
 * Hardware / bridge safety: this spec must never open a real Hue stream.
 * - Off is always safe — it needs no output target — and is exercised
 *   unconditionally.
 * - Ambilight and Solid are only exercised when the app's own gate already
 *   allows it (`hasAnyOutput` in `CompactLayout.tsx` — read here via the
 *   button's `disabled` attribute, never bypassed) AND the StatusBar's HUE
 *   pill offers its set-up link, meaning no bridge is paired at all. A local
 *   run can have a real bridge reachable on the LAN; the second check is what
 *   stops this spec from ever driving a live DTLS stream to it. A
 *   configured-but-unreachable bridge (a reconnect link) is treated the same
 *   as reachable and skipped too, out of caution.
 * - A locally connected WLED target is not specifically excluded: driving
 *   Solid at it for the duration of one assertion, then returning to Off, is
 *   treated as an acceptable side effect of a real local run — it carries
 *   none of Hue's session/auth state.
 */
describe("lighting mode switch", () => {
  let startUiMode: UIMode;
  let startModeKind: string | null;

  before(async () => {
    await waitForAppReady();
    startUiMode = await currentUiMode();
    await switchUiMode("compact");
    startModeKind = await activeModeKind();
  });

  after(async () => {
    if (startModeKind !== null && (await activeModeKind()) !== startModeKind) {
      await clickTestId(`mode-button-${startModeKind}`);
      await waitForModePressed(startModeKind);
    }
    await switchUiMode(startUiMode);
  });

  it("drives Off from the mode strip and reads it back through aria-checked", async () => {
    await clickTestId(`mode-button-${LIGHTING_MODE_KIND.OFF}`);
    await waitForModePressed(LIGHTING_MODE_KIND.OFF);
    await expectExactlyOnePressed();
  });

  it("only drives Ambilight/Solid when the app's own gate allows it and no Hue bridge is paired", async () => {
    if (await hueConfigured()) {
      console.log(
        "[e2e] skip: a Hue bridge is paired on this machine — refusing to touch " +
          "Ambilight/Solid so this run can never open a real entertainment stream",
      );
      return;
    }

    for (const kind of [LIGHTING_MODE_KIND.SOLID, LIGHTING_MODE_KIND.AMBILIGHT]) {
      if (await isDisabled(`[data-testid="mode-button-${kind}"]`)) {
        console.log(
          `[e2e] skip ${kind}: no reachable output target on this machine (button disabled) — ` +
            "this is the app's own hasAnyOutput gate, not a spec-side guess",
        );
        continue;
      }

      await clickTestId(`mode-button-${kind}`);
      await waitForModePressed(kind);
      await expectExactlyOnePressed();

      await clickTestId(`mode-button-${LIGHTING_MODE_KIND.OFF}`);
      await waitForModePressed(LIGHTING_MODE_KIND.OFF);
    }
  });
});
