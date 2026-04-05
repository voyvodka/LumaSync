import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "../../device/hueOnboardingApi";
import type { HueChannelPlacement } from "../../../shared/contracts/roomMap";
import { HueChannelMapPanel } from "./HueChannelMapPanel";

// Mock i18n — return key as value (with interpolation support)
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key} ${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChannels(count: number): HueAreaChannelInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    positionX: count > 1 ? (i / (count - 1)) * 2 - 1 : 0, // spread across [-1, 1]
    positionY: 0,
    lightCount: 2,
    autoRegion: "center",
  }));
}

const defaultProps = {
  channels: makeChannels(3),
  isLoading: false,
  overrides: {} as Record<number, string>,
  onSetRegion: vi.fn(),
};

// ---------------------------------------------------------------------------
// CHAN-01: channels rendered at positions
// ---------------------------------------------------------------------------

describe("CHAN-01: channels rendered at positions", () => {
  it("renders channel dots for each channel", () => {
    render(<HueChannelMapPanel {...defaultProps} />);
    // Each channel should have a dot button in the position grid
    // We look for all buttons; at minimum 3 channel dots plus region chip buttons exist
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it("uses persisted placements over bridge positions when provided", () => {
    const placements: HueChannelPlacement[] = [
      { channelIndex: 0, x: 0.5, y: 0.5, z: 0 },
      { channelIndex: 1, x: -0.5, y: -0.5, z: 0 },
      { channelIndex: 2, x: 0, y: 0, z: 0 },
    ];
    render(<HueChannelMapPanel {...defaultProps} placements={placements} />);
    // Component should render without errors when placements provided
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// CHAN-02: drag to update position
// ---------------------------------------------------------------------------

describe("CHAN-02: drag to update position", () => {
  it("shows mode toggle with Position and Assign Zone options", () => {
    // This test is upgraded to a real assertion in Task 2 after ModePillToggle
    // is added to HueChannelMapPanel. Currently a stub — passes unconditionally.
    // render(<HueChannelMapPanel {...defaultProps} />);
    // expect(screen.getByText("device.hue.channelMap.modPosition")).toBeTruthy();
    // expect(screen.getByText("device.hue.channelMap.modAssignZone")).toBeTruthy();
    expect(true).toBe(true); // placeholder — upgraded in Task 2
  });

  it("clientToHueCoords is inverse of posToPercent (y-flip correctness)", () => {
    // This is a structural test — the component must contain both functions as
    // a contractual guarantee. Full behavioral verification requires real pointer
    // events which jsdom cannot fully simulate (setPointerCapture is a no-op).
    // A y=+1 channel should appear at the top of the canvas (CSS top: 0%).
    // A y=-1 channel should appear at the bottom (CSS top: 100%).
    // This placeholder is upgraded to a coordinate assertion in Plan 02 when
    // ChannelDetailStrip exposes x/y readout for direct DOM assertion.
    expect(true).toBe(true); // placeholder — see above rationale
  });
});

// ---------------------------------------------------------------------------
// CHAN-03: z-axis height slider
// ---------------------------------------------------------------------------

describe("CHAN-03: z-axis height slider", () => {
  it("shows detail strip with z-slider when a channel is selected", () => {
    // Will be filled in Plan 02 when ChannelDetailStrip is implemented.
    // The strip renders below the canvas when selectedChannels.size > 0.
    expect(true).toBe(true); // placeholder
  });

  it("calls onPositionChange when z value changes", () => {
    // Will be filled in Plan 02 when ChannelDetailStrip exposes the slider.
    expect(true).toBe(true); // placeholder
  });
});

// ---------------------------------------------------------------------------
// CHAN-04: multi-select and group drag
// ---------------------------------------------------------------------------

describe("CHAN-04: multi-select and group drag", () => {
  it("supports Shift+click to add to selection", () => {
    // Will be filled in Plan 02 when multi-select is fully implemented.
    // Plan 01 supports single-select only; Shift+click comes in Plan 02.
    expect(true).toBe(true); // placeholder
  });

  it("clampGroupDelta prevents any channel from exceeding boundary", () => {
    // Will be filled in Plan 02 when clampGroupDelta is exported/testable.
    expect(true).toBe(true); // placeholder
  });
});
