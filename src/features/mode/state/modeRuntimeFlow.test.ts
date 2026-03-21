import { describe, expect, it } from "vitest";

import type { LightingModeConfig } from "../model/contracts";
import { resolveModeTransition } from "./modeRuntimeFlow";

const AMBILIGHT_MODE: LightingModeConfig = {
  kind: "ambilight",
  ambilight: { brightness: 0.8 },
};

const SOLID_MODE: LightingModeConfig = {
  kind: "solid",
  solid: { r: 120, g: 90, b: 60, brightness: 0.6 },
};

describe("resolveModeTransition", () => {
  it("produces stopPrevious=true and startNext=ambilight when switching to ambilight", () => {
    expect(resolveModeTransition(undefined, AMBILIGHT_MODE)).toEqual({
      stopPrevious: true,
      startNext: "ambilight",
      steps: ["stop", "start:ambilight"],
    });
  });

  it("stops previous runtime before starting solid when transitioning ambilight -> solid", () => {
    expect(resolveModeTransition(AMBILIGHT_MODE, SOLID_MODE)).toEqual({
      stopPrevious: true,
      startNext: "solid",
      steps: ["stop", "start:solid"],
    });
  });
});
