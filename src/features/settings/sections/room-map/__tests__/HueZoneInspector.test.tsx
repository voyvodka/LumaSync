/**
 * HueZoneInspector regression tests.
 *
 * Coverage for v1.5 W4-I "physical 1:1 metric square" + W4-K
 * single-row layout refactor:
 *  - The size slider edits a metre value; we derive per-axis cube-
 *    space scales as `edge_m / room{Width,Depth}M` so the zone paints
 *    as a true physical square on the canvas.
 *  - Maximum edge equals `min(roomWidthM, roomDepthM)` so the zone
 *    never spills outside the room footprint.
 *  - Legacy zones with asymmetric scales (pre-W4-I writes) resolve
 *    onto the smaller of `scaleX*roomW` / `scaleY*roomD` so the slider
 *    value is well-defined and the rendered square fits inside the
 *    persisted bounds.
 *  - W4-K — the redundant `{edge}m × {edge}m` metric reader is gone;
 *    the EDGE field and HEX field share a single side-by-side row,
 *    and the hex input commits to `borderColor`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";

import { HueZoneInspector } from "../HueZoneInspector";
import type { HueZone } from "../../../../../shared/contracts/roomMap";

// Mirror the production locale `roomMap.inspector` keys we reference so
// vars get interpolated identically to a real i18n run. Anything not
// listed here returns the bare key (fine for non-visual labels).
const FIXTURE_LOCALES: Record<string, string> = {
  "roomMap.inspector.zoneSize": "Size",
  "roomMap.inspector.zoneEdgeShort": "Edge",
  "roomMap.inspector.zoneEdgeAriaLabel": "Zone edge length in metres",
  "roomMap.inspector.zoneHexShort": "Hex",
  "roomMap.inspector.zoneHexAriaLabel": "Zone color hex value",
  "roomMap.inspector.zoneSizeHint":
    "Zone is a 1:1 square; max equals the shorter room side.",
  "roomMap.inspector.typeHueZone": "Hue zone",
  "roomMap.zoneProperties.color": "Color",
  "roomMap.zoneProperties.swatchAriaLabel": "Use {{name}} swatch",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const template = FIXTURE_LOCALES[key] ?? key;
      if (!vars) return template;
      let resolved = template;
      for (const [k, v] of Object.entries(vars)) {
        resolved = resolved.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
      }
      return resolved;
    },
  }),
}));

// Trim the picker dependency — irrelevant to scale-axis assertions.
vi.mock("../../../../shared/ui/HsvColorPicker", () => ({
  HsvColorPicker: () => <div data-testid="hsv-stub" />,
}));

beforeEach(() => {
  cleanup();
});

const BASE_ZONE: HueZone = {
  id: "zone-1",
  name: "Sofa back-light",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  // 0.5 × 5m = 2.5m on X, 0.5 × 4m = 2.0m on Y → physical edge 2.0m
  // (the smaller of the two) once resolved through the W4-I helper.
  scaleX: 0.5,
  scaleY: 0.5,
  scaleZ: 0.5,
  channelIndices: [],
  borderColor: "#3b82f6",
};

describe("HueZoneInspector — W4-I physical metric square", () => {
  it("derives per-axis cube-space scales from a single edge length when the slider moves", () => {
    const onUpdate = vi.fn();
    render(
      <HueZoneInspector
        zone={BASE_ZONE}
        onUpdate={onUpdate}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );

    const slider = screen.getByTestId("hue-zone-size-slider") as HTMLInputElement;
    // Drag the slider to a 3 m physical edge. In a 5×4 m room that
    // resolves to scaleX = 3/5 = 0.6 and scaleY = 3/4 = 0.75 — the
    // asymmetric write that paints a true square on the metric canvas.
    fireEvent.change(slider, { target: { value: "3" } });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0][0];
    expect(patch).toHaveProperty("scaleX");
    expect(patch).toHaveProperty("scaleY");
    expect(patch.scaleX).toBeCloseTo(0.6, 5);
    expect(patch.scaleY).toBeCloseTo(0.75, 5);
  });

  it("clamps edge length to the shorter room side and keeps both axes ≤ 1.0", () => {
    const onUpdate = vi.fn();
    render(
      <HueZoneInspector
        zone={BASE_ZONE}
        onUpdate={onUpdate}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );

    const slider = screen.getByTestId("hue-zone-size-slider") as HTMLInputElement;
    // 6 m exceeds the 4 m short side; component clamps to 4 m before
    // deriving the cube-space scales (Rust would reject 6/4 = 1.5 with
    // HUE_ZONE_OVERSIZED, so the UI fail-closes ahead of the boundary).
    fireEvent.change(slider, { target: { value: "6" } });
    const patch = onUpdate.mock.calls[0][0];
    expect(patch.scaleX).toBeLessThanOrEqual(1.0);
    expect(patch.scaleY).toBeLessThanOrEqual(1.0);
    expect(patch.scaleY).toBeCloseTo(1.0, 5); // 4m / 4m
    expect(patch.scaleX).toBeCloseTo(0.8, 5); // 4m / 5m
  });

  it("resolves legacy asymmetric zones onto the smaller physical edge", () => {
    // Legacy persisted zone written before W4-I — scaleX/scaleY do not
    // necessarily resolve to a square in metres. The Inspector takes
    // `min(scaleX*roomW, scaleY*roomD)` so the displayed edge fits
    // inside whatever the bridge currently reports.
    const legacy: HueZone = { ...BASE_ZONE, scaleX: 0.6, scaleY: 0.4 };
    render(
      <HueZoneInspector
        zone={legacy}
        onUpdate={() => {}}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );
    const slider = screen.getByTestId("hue-zone-size-slider") as HTMLInputElement;
    // 0.6 × 5 = 3.0 m vs 0.4 × 4 = 1.6 m → resolved edge = 1.6 m.
    expect(parseFloat(slider.value)).toBeCloseTo(1.6, 5);
  });

  it("disables the controls when room dimensions have not loaded yet", () => {
    // RoomMapEditor mounts the inspector before `config.dimensions`
    // resolves on initial load. Disable the slider + input rather than
    // dividing by zero in the cube-space derivation.
    render(
      <HueZoneInspector
        zone={BASE_ZONE}
        onUpdate={() => {}}
        roomWidthM={0}
        roomDepthM={0}
      />,
    );
    const slider = screen.getByTestId("hue-zone-size-slider") as HTMLInputElement;
    const input = screen.getByTestId("hue-zone-size-edge-input") as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(input.disabled).toBe(true);
  });
});

describe("HueZoneInspector — W4-K single-row layout", () => {
  it("does not render the redundant {edge}m × {edge}m metric reader", () => {
    // The W4-I metric reader collided with the HSV recent strip on
    // narrow docks; W4-K drops it because the EDGE field above already
    // shows the same number.
    const { container } = render(
      <HueZoneInspector
        zone={{ ...BASE_ZONE, scaleX: 0.4, scaleY: 0.5 }}
        onUpdate={() => {}}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );
    expect(container.textContent).not.toMatch(/\d\.\d{2}m × \d\.\d{2}m/);
  });

  it("renders an inline hex input that commits a normalised borderColor on blur", () => {
    const onUpdate = vi.fn();
    render(
      <HueZoneInspector
        zone={BASE_ZONE}
        onUpdate={onUpdate}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );

    const hexInput = screen.getByTestId("hue-zone-hex-input") as HTMLInputElement;
    expect(hexInput).toBeTruthy();

    // User types a different valid hex (uppercase, with hash) and
    // blurs — Inspector commits a lowercased canonical value to the
    // borderColor patch so persistence stays case-stable.
    fireEvent.focus(hexInput);
    fireEvent.change(hexInput, { target: { value: "#0BD1F5" } });
    fireEvent.blur(hexInput);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toEqual({ borderColor: "#0bd1f5" });
  });

  it("rejects invalid hex on blur and reverts the draft to the persisted value", () => {
    const onUpdate = vi.fn();
    render(
      <HueZoneInspector
        zone={BASE_ZONE}
        onUpdate={onUpdate}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );
    const hexInput = screen.getByTestId("hue-zone-hex-input") as HTMLInputElement;

    fireEvent.focus(hexInput);
    fireEvent.change(hexInput, { target: { value: "not-a-hex" } });
    fireEvent.blur(hexInput);

    // Invalid hex never reaches the parent.
    expect(onUpdate).not.toHaveBeenCalled();
    // And the draft snaps back to the canonical persisted value.
    expect(hexInput.value).toBe("#3B82F6");
  });
});
