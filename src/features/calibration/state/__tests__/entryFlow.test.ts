import { describe, expect, it } from "vitest";

import { shouldPromptLedSetupOnConnection } from "../entryFlow";

describe("calibration entry flow", () => {
  it("prompts on a connect the user made when calibration is missing", () => {
    expect(
      shouldPromptLedSetupOnConnection({ userInitiated: true, hasCalibration: false, alreadyPrompted: false }),
    ).toBe(true);
  });

  it("does not prompt when a calibration is saved", () => {
    expect(
      shouldPromptLedSetupOnConnection({ userInitiated: true, hasCalibration: true, alreadyPrompted: false }),
    ).toBe(false);
  });

  // The boot auto-reconnect is not a first connect: it prompted on every launch.
  it("does not prompt for a connect the app made on its own", () => {
    expect(
      shouldPromptLedSetupOnConnection({ userInitiated: false, hasCalibration: false, alreadyPrompted: false }),
    ).toBe(false);
  });

  it("prompts once", () => {
    expect(
      shouldPromptLedSetupOnConnection({ userInitiated: true, hasCalibration: false, alreadyPrompted: true }),
    ).toBe(false);
  });
});
