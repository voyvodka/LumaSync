import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeStatus,
} from "@/shared/contracts/hue";
import type { ShellState } from "@/shared/contracts/shell";
import {
  DEFAULT_EFFECT,
  DEFAULT_SOLID_COLOR,
  LIGHTING_MODE_KIND,
  isLightingModeKind,
  normalizeAmbilightPayload,
  normalizeEffectPayload,
  normalizeColorOrder,
  normalizeLightingModeConfig,
  normalizeOutputTargets,
  normalizeSolidColorPayload,
} from "../mode";

const CALIBRATION: LedCalibrationConfig = {
  templateId: "monitor-27-16-9",
  counts: {
    top: 36,
    right: 22,
    bottom: 34,
    left: 22,
  },
  bottomMissing: 2,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 114,
};

describe("lighting mode contracts", () => {
  it("accepts only off | ambilight | solid | effect mode kind values", () => {
    expect(LIGHTING_MODE_KIND).toEqual({
      OFF: "off",
      AMBILIGHT: "ambilight",
      SOLID: "solid",
      EFFECT: "effect",
    });

    expect(isLightingModeKind("off")).toBe(true);
    expect(isLightingModeKind("ambilight")).toBe(true);
    expect(isLightingModeKind("solid")).toBe(true);
    expect(isLightingModeKind("effect")).toBe(true);
    expect(isLightingModeKind("rainbow")).toBe(false);
  });

  // Rust reads an unknown id as the wave; so does the frontend, or the two would disagree.
  it("normalises an effect into range, an unknown id to the wave", () => {
    expect(normalizeEffectPayload({ id: "lightning", speed: 3, brightness: -1 })).toEqual({
      id: "wave",
      speed: 1,
      brightness: 0,
    });
    expect(normalizeLightingModeConfig({ kind: "effect" }).effect).toEqual(DEFAULT_EFFECT);
  });

  // Mirrors `a_v1_effect_reads_as_its_v2_equivalent` in effect_tests.rs.
  it("reads a v1 effect as what it became", () => {
    expect(normalizeEffectPayload({ id: "rainbow", speed: 0.3, brightness: 1 })).toMatchObject({
      id: "wave",
      palette: "rainbow",
    });
    expect(normalizeEffectPayload({ id: "cycle" })).toMatchObject({ id: "cycle", palette: "rainbow" });
    expect(normalizeEffectPayload({ id: "breathe", color: { r: 10, g: 20, b: 30 } })).toMatchObject({
      id: "breathe",
      palette: "custom",
      colors: [{ r: 10, g: 20, b: 30 }],
    });
    expect(normalizeEffectPayload({ id: "breathe" }).colors).toEqual([{ r: 255, g: 176, b: 32 }]);
  });

  // Mirrors `a_bad_field_fails_soft_on_its_own`.
  it("drops a bad effect field on its own and keeps the rest", () => {
    const effect = normalizeEffectPayload({
      id: "candle",
      speed: "fast" as never,
      palette: "neon" as never,
      direction: 7 as never,
      colors: [{ r: 300, g: 12.7, b: -4 }, "red" as never, { r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }],
      intensity: 2,
      durationMinutes: 900,
    });
    expect(effect).toEqual({
      id: "candle",
      speed: 0.5,
      brightness: 1,
      colors: [
        { r: 255, g: 12, b: 0 },
        { r: 1, g: 2, b: 3 },
        { r: 4, g: 5, b: 6 },
      ],
      intensity: 1,
      durationMinutes: 120,
    });
  });

  it("keeps a white solid's temperature in range", () => {
    expect(normalizeSolidColorPayload({ r: 1, g: 2, b: 3, brightness: 1, kelvin: 99999 }).kelvin).toBe(6500);
    expect(normalizeSolidColorPayload({ r: 1, g: 2, b: 3, brightness: 1 })).not.toHaveProperty("kelvin");
  });

  it("normalizes solid mode payload as r,g,b,brightness", () => {
    expect(
      normalizeSolidColorPayload({
        r: 300,
        g: -10,
        b: 10.9,
        brightness: 2,
      }),
    ).toEqual({
      r: 255,
      g: 0,
      b: 10,
      brightness: 1,
    });
  });

  it("clamps ambilight payload fields to contract ranges with sensible defaults", () => {
    expect(normalizeAmbilightPayload({})).toEqual({
      brightness: 1,
      blackBorderDetection: false,
      smoothingAlpha: 0.35,
      saturation: 1,
    });

    expect(
      normalizeAmbilightPayload({
        brightness: 2,
        smoothingAlpha: 5,
        saturation: 9,
      }),
    ).toMatchObject({
      brightness: 1,
      smoothingAlpha: 1,
      saturation: 2,
    });

    expect(
      normalizeAmbilightPayload({
        brightness: -0.5,
        smoothingAlpha: 0,
        saturation: 0,
      }),
    ).toMatchObject({
      brightness: 0,
      smoothingAlpha: 0.05,
      saturation: 0.5,
    });

    // Non-finite inputs (NaN / ±Infinity) fall back to the per-field default
    // BEFORE clamping — they do not clamp to min/max. This matches the
    // toFiniteNumber + clampFloat pipeline in contracts.ts.
    expect(
      normalizeAmbilightPayload({
        brightness: Number.NaN,
        smoothingAlpha: Number.NEGATIVE_INFINITY,
        saturation: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({
      brightness: 1,
      smoothingAlpha: 0.35,
      saturation: 1,
    });

    expect(normalizeAmbilightPayload({ blackBorderDetection: true }).blackBorderDetection).toBe(true);
  });

  it("keeps the strip layout contract intact when shell state includes lighting mode fields", () => {
    const shellState: ShellState = {
      schemaVersion: 1,
      windowCenterX: null,
      windowCenterY: null,
      lastSection: "lights",
      trayHintShown: true,
      ledStrips: [{ id: "strip-1", enabled: true, transport: null, hardware: {}, layout: CALIBRATION }],
      lightingMode: {
        kind: "solid",
        solid: {
          r: 120,
          g: 70,
          b: 40,
          brightness: 0.5,
        },
      },
    };

    expect(shellState.ledStrips?.[0]?.layout).toEqual(CALIBRATION);
  });

  it("exports Hue runtime lifecycle states as Idle/Starting/Running/Reconnecting/Stopping/Failed", () => {
    expect(HUE_RUNTIME_STATES).toEqual({
      IDLE: "Idle",
      STARTING: "Starting",
      RUNNING: "Running",
      RECONNECTING: "Reconnecting",
      STOPPING: "Stopping",
      FAILED: "Failed",
    });
  });

  it("supports retry metadata and action hint in Hue runtime status shape", () => {
    const runtimeStatus: HueRuntimeStatus = {
      state: "Reconnecting",
      code: "TRANSIENT_RETRY_SCHEDULED",
      message: "Retrying Hue stream.",
      details: "socket timeout",
      remainingAttempts: 3,
      nextAttemptMs: 800,
      actionHint: HUE_RUNTIME_ACTION_HINT.RECONNECT,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    };

    expect(runtimeStatus.remainingAttempts).toBe(3);
    expect(runtimeStatus.nextAttemptMs).toBe(800);
    expect(runtimeStatus.actionHint).toBe("reconnect");
    expect(runtimeStatus.triggerSource).toBe("mode_control");
  });

});

describe("normalizeOutputTargets (INV-33)", () => {
  it("treats a non-array as first install and returns the default", () => {
    expect(normalizeOutputTargets(undefined)).toEqual(["usb"]);
    expect(normalizeOutputTargets(null)).toEqual(["usb"]);
    expect(normalizeOutputTargets("usb")).toEqual(["usb"]);
  });

  it("treats an explicit empty array as intentional and returns it", () => {
    // The unsupported-port fallback relies on this: reverting `[]` to the
    // default would re-add the very target it is trying to drop.
    expect(normalizeOutputTargets([])).toEqual([]);
  });

  it("dedupes and returns a stable usb,hue order", () => {
    expect(normalizeOutputTargets(["hue", "usb"])).toEqual(["usb", "hue"]);
    expect(normalizeOutputTargets(["usb", "usb", "hue"])).toEqual(["usb", "hue"]);
  });

  it("drops unknown target values", () => {
    expect(normalizeOutputTargets(["usb", "wled", 3, null])).toEqual(["usb"]);
    expect(normalizeOutputTargets(["wled"])).toEqual([]);
  });

  it("returns a fresh array so the default is never mutated by a caller", () => {
    const first = normalizeOutputTargets(undefined);
    first.push("hue");
    expect(normalizeOutputTargets(undefined)).toEqual(["usb"]);
  });
});

describe("normalizeLightingModeConfig room geometry", () => {
  // A persisted geometry would outlive the room map it was projected from.
  it("never round-trips roomGeometry, whatever the kind", () => {
    const roomGeometry = {
      dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
      tv: { x: 1.5, y: 0, width: 2, height: 0.3 },
      huePlacements: [],
    };
    for (const kind of [LIGHTING_MODE_KIND.AMBILIGHT, LIGHTING_MODE_KIND.SOLID, LIGHTING_MODE_KIND.OFF]) {
      expect(normalizeLightingModeConfig({ kind, roomGeometry })).not.toHaveProperty("roomGeometry");
    }
  });
});

describe("normalizeLightingModeConfig colour order", () => {
  // The function rebuilds the config field by field per kind, and the shell
  // verifier cannot see this file, so a branch that forgets the field silently
  // drops the order from every payload of that kind.
  it.each(Object.values(LIGHTING_MODE_KIND))("keeps colorOrder on the %s branch", (kind) => {
    expect(normalizeLightingModeConfig({ kind, colorOrder: "grb" }).colorOrder).toBe("grb");
  });

  it("keeps it on the fallback branch an unknown kind lands in", () => {
    const normalized = normalizeLightingModeConfig({
      kind: "rainbow" as never,
      colorOrder: "bgr",
    });
    expect(normalized.kind).toBe(LIGHTING_MODE_KIND.OFF);
    expect(normalized.colorOrder).toBe("bgr");
  });

  it("drops an unknown order instead of letting it fail the Rust payload", () => {
    expect(
      normalizeLightingModeConfig({ kind: "solid", colorOrder: "xyz" as never }).colorOrder,
    ).toBeUndefined();
  });

  it("never invents the default for an absent order", () => {
    // A made-up "rgb" would win caller-wins hydration over the saved order.
    expect(normalizeLightingModeConfig({ kind: "ambilight" }).colorOrder).toBeUndefined();
    expect(normalizeColorOrder(undefined)).toBeUndefined();
    expect(normalizeColorOrder("GRB")).toBeUndefined();
    expect(normalizeColorOrder("gbr")).toBe("gbr");
  });
});

// Compact defaulted to a warm white the full window and the popup did not.
describe("DEFAULT_SOLID_COLOR", () => {
  it("is what a Solid config with no colour normalises to — the white Rust applies", () => {
    expect(normalizeSolidColorPayload()).toEqual(DEFAULT_SOLID_COLOR);
    expect(DEFAULT_SOLID_COLOR).toEqual({ r: 255, g: 255, b: 255, brightness: 1 });
  });
});
