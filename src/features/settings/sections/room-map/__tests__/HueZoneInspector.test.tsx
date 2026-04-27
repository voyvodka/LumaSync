/**
 * HueZoneInspector regression tests.
 *
 * Bug-driven coverage for v1.5 W4-C "size is room-relative + AR-locked":
 *  - The size slider always writes `scaleX === scaleY` so the zone
 *    aspect ratio mirrors the room ("en boy oranı değişemez").
 *  - The metric read-out resolves zone size in metres against the
 *    supplied room dimensions ("zone is 2.5m × 2.0m at 50%").
 *  - Legacy zones with `scaleX !== scaleY` snap onto the larger axis on
 *    first interaction so the slider value is well-defined.
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
  "roomMap.inspector.zoneSizeMetric": "{{width}}m × {{depth}}m",
  "roomMap.inspector.zoneSizeMetricAriaLabel":
    "Zone size: {{width}} metres wide by {{depth}} metres deep, {{percent}}% of the room",
  "roomMap.inspector.zoneSizeHint":
    "Zone aspect ratio matches the room. Maximum size equals the room.",
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
  scaleX: 0.5,
  scaleY: 0.5,
  scaleZ: 0.5,
  channelIndices: [],
  borderColor: "#3b82f6",
};

describe("HueZoneInspector — W4-C uniform AR-locked size", () => {
  it("writes scaleX and scaleY in lockstep when the size slider moves", () => {
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
    fireEvent.change(slider, { target: { value: "0.75" } });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0][0];
    expect(patch).toHaveProperty("scaleX", 0.75);
    expect(patch).toHaveProperty("scaleY", 0.75);
    expect(patch.scaleX).toBe(patch.scaleY);
  });

  it("clamps slider input to [0.05, 1.0] before propagating", () => {
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
    // Browser slider input would already clamp to its `max=1`, but we
    // assert the component-level guard for callers writing programmatic
    // values beyond the slider bounds (e.g. legacy persisted zones).
    fireEvent.change(slider, { target: { value: "5" } });
    const patch = onUpdate.mock.calls[0][0];
    expect(patch.scaleX).toBeLessThanOrEqual(1.0);
    expect(patch.scaleY).toBeLessThanOrEqual(1.0);
    expect(patch.scaleX).toBe(patch.scaleY);
  });

  it("renders the metric read-out as fraction × room dimensions", () => {
    const { container } = render(
      <HueZoneInspector
        zone={{ ...BASE_ZONE, scaleX: 0.5, scaleY: 0.5 }}
        onUpdate={() => {}}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );
    // 0.5 × 5m = 2.50m, 0.5 × 4m = 2.00m
    expect(container.textContent).toContain("2.50m");
    expect(container.textContent).toContain("2.00m");
  });

  it("collapses asymmetric legacy zones onto the larger axis for the slider", () => {
    // Legacy persisted zone: scaleX=0.4, scaleY=0.6 (pre-W4-C). The
    // Inspector resolves the slider to the larger axis (0.6) so the
    // user does not see the zone shrink to the smaller value on first
    // load. The Rust validator will reject any persisted asymmetric
    // write going forward, but read-side resilience matters.
    const legacy: HueZone = { ...BASE_ZONE, scaleX: 0.4, scaleY: 0.6 };
    render(
      <HueZoneInspector
        zone={legacy}
        onUpdate={() => {}}
        roomWidthM={5}
        roomDepthM={4}
      />,
    );
    const slider = screen.getByTestId("hue-zone-size-slider") as HTMLInputElement;
    expect(parseFloat(slider.value)).toBeCloseTo(0.6, 5);
  });

  it("reports zero metres when room dimensions are not yet loaded", () => {
    // RoomMapEditor mounts the inspector before `config.dimensions`
    // resolves on initial load. Falling back to `0` instead of NaN keeps
    // the read-out coherent during that brief window.
    const { container } = render(
      <HueZoneInspector
        zone={BASE_ZONE}
        onUpdate={() => {}}
        roomWidthM={0}
        roomDepthM={0}
      />,
    );
    expect(container.textContent).toContain("0.00m");
  });
});
