import { describe, expect, it } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../../model/contracts";
import {
  canonicalLightingModeSignature,
  hydrateModePayload,
  withAmbilightLightingSmoothingPreset,
  withAmbilightSettings,
  withLedCalibration,
  withSelectedDisplayId,
  type ModeRuntimeConfigSnapshot,
} from "../modePayloadHydration";

const emptySnapshot: ModeRuntimeConfigSnapshot = {
  selectedDisplayId: undefined,
  lightingSmoothingPreset: "moderate",
  colorCorrection: undefined,
  firmwareProfile: undefined,
  chipType: undefined,
  savedCalibration: undefined,
  savedAmbilight: undefined,
};

const calibration = {
  templateId: "monitor-27-16-9",
  counts: { top: 10, right: 10, bottom: 10, left: 10 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "subtle",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 40,
} as unknown as NonNullable<ModeRuntimeConfigSnapshot["savedCalibration"]>;

describe("withSelectedDisplayId", () => {
  it("stamps the id only when one is set", () => {
    const mode: LightingModeConfig = { kind: LIGHTING_MODE_KIND.SOLID };
    expect(withSelectedDisplayId(mode, emptySnapshot).displayId).toBeUndefined();
    expect(
      withSelectedDisplayId(mode, { ...emptySnapshot, selectedDisplayId: "" }).displayId,
    ).toBeUndefined();
    expect(
      withSelectedDisplayId(mode, { ...emptySnapshot, selectedDisplayId: "disp-2" }).displayId,
    ).toBe("disp-2");
  });
});

describe("withLedCalibration (INV-4)", () => {
  it("is caller-wins and no-ops when the snapshot is unset", () => {
    const explicit = { totalLeds: 7 } as unknown as LightingModeConfig["ledCalibration"];
    const withExplicit: LightingModeConfig = {
      kind: LIGHTING_MODE_KIND.SOLID,
      ledCalibration: explicit,
    };
    expect(
      withLedCalibration(withExplicit, { ...emptySnapshot, savedCalibration: calibration })
        .ledCalibration,
    ).toBe(explicit);

    const bare: LightingModeConfig = { kind: LIGHTING_MODE_KIND.SOLID };
    expect(withLedCalibration(bare, emptySnapshot).ledCalibration).toBeUndefined();
    expect(
      withLedCalibration(bare, { ...emptySnapshot, savedCalibration: calibration })
        .ledCalibration,
    ).toBe(calibration);
  });
});

describe("withAmbilightSettings (INV-3)", () => {
  const snapshot: ModeRuntimeConfigSnapshot = {
    ...emptySnapshot,
    savedAmbilight: { brightness: 0.4, saturation: 1.7, blackBorderDetection: true },
  };

  it("stamps persisted values onto a fresh-default payload", () => {
    const stamped = withAmbilightSettings(
      { kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight: { brightness: 1 } },
      snapshot,
    );
    expect(stamped.ambilight).toEqual({
      brightness: 1,
      saturation: 1.7,
      blackBorderDetection: true,
    });
  });

  it("stamps when the caller supplied no ambilight payload at all", () => {
    const stamped = withAmbilightSettings({ kind: LIGHTING_MODE_KIND.AMBILIGHT }, snapshot);
    expect(stamped.ambilight?.saturation).toBe(1.7);
  });

  it("is caller-wins for an explicit non-default commit", () => {
    const explicit = { brightness: 0.9, saturation: 1.2, blackBorderDetection: false };
    const kept = withAmbilightSettings(
      { kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight: explicit },
      snapshot,
    );
    expect(kept.ambilight).toBe(explicit);
  });

  it("leaves solid and off untouched", () => {
    const solid: LightingModeConfig = { kind: LIGHTING_MODE_KIND.SOLID };
    expect(withAmbilightSettings(solid, snapshot)).toBe(solid);
  });
});

describe("hydrateModePayload composition order (INV-5)", () => {
  it("runs the settings stamp before the preset stamp so the preset survives", () => {
    const hydrated = hydrateModePayload(
      { kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight: { brightness: 1 } },
      {
        ...emptySnapshot,
        lightingSmoothingPreset: "intense",
        savedAmbilight: {
          brightness: 0.4,
          saturation: 1.7,
          lightingSmoothingPreset: "subtle",
        },
      },
    );
    // Persisted saturation survives AND the live preset wins over the
    // persisted one — only this ordering produces both.
    expect(hydrated.ambilight?.saturation).toBe(1.7);
    expect(hydrated.ambilight?.lightingSmoothingPreset).toBe("intense");
  });

  it("does not let the preset stamp resurrect ambilight on a solid payload", () => {
    const hydrated = withAmbilightLightingSmoothingPreset(
      { kind: LIGHTING_MODE_KIND.SOLID },
      emptySnapshot,
    );
    expect(hydrated.ambilight).toBeUndefined();
  });

  it("always stamps colour correction, firmware profile and chip type", () => {
    const hydrated = hydrateModePayload({ kind: LIGHTING_MODE_KIND.OFF }, {
      ...emptySnapshot,
      firmwareProfile: "adalight",
      chipType: "sk6812-rgbw",
    } as ModeRuntimeConfigSnapshot);
    expect(hydrated.firmwareProfile).toBe("adalight");
    expect(hydrated.chipType).toBe("sk6812-rgbw");
  });
});

describe("canonicalLightingModeSignature (INV-6)", () => {
  it("is key-order independent", () => {
    const a = { kind: "ambilight", ambilight: { brightness: 0.8, saturation: 1 } };
    const b = { ambilight: { saturation: 1, brightness: 0.8 }, kind: "ambilight" };
    expect(canonicalLightingModeSignature(a)).toBe(canonicalLightingModeSignature(b));
  });

  it("strips undefined values so an absent field equals an explicit undefined", () => {
    expect(canonicalLightingModeSignature({ kind: "off", displayId: undefined })).toBe(
      canonicalLightingModeSignature({ kind: "off" }),
    );
  });

  it("preserves array order — targets are semantically ordered", () => {
    expect(canonicalLightingModeSignature({ targets: ["usb", "hue"] })).not.toBe(
      canonicalLightingModeSignature({ targets: ["hue", "usb"] }),
    );
  });

  it("still separates genuinely different content", () => {
    expect(canonicalLightingModeSignature({ kind: "off" })).not.toBe(
      canonicalLightingModeSignature({ kind: "solid" }),
    );
  });
});
