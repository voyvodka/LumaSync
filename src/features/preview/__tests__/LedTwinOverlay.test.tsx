/**
 * LedTwinOverlay — memo bail-out regression tests.
 *
 * The defect these guard: `colorAt` used to hand each dot `frame.leds[i]`, a
 * freshly deserialised array on every 10 Hz frame, so `LedGlowDot`'s shallow
 * memo compare never matched and all N dots re-rendered per frame.
 *
 * The counter lives at module scope inside a stand-in that keeps the REAL
 * memo semantics (`memo` + default shallow compare). A `<Profiler>`-based
 * assertion cannot be used here: it fires on every commit even when a memo'd
 * child bails out, so it would pass for the wrong reason.
 *
 * Covers:
 *   - A repeated identical frame re-renders zero dots.
 *   - A frame that moves ONE LED re-renders exactly one dot.
 *   - Edge ribbon gradients still track live colour changes.
 */

import { render, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo } from "react";

import type { EdgeSignalPayload } from "../../mode/model/contracts";
import type { LedCalibrationConfig } from "../../calibration/model/contracts";

let dotRenderCount = 0;

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../persistence/shellStore", () => ({
  shellStore: { load: vi.fn() },
}));

// Stand-in for LedGlowDot that preserves the real memo + shallow-compare
// semantics; a prop that is not compared by value fails to bail out here
// exactly as it does in the real component.
vi.mock("../ui/LedGlowDot", () => ({
  LedGlowDot: memo(function LedGlowDot(props: {
    x: number;
    y: number;
    color: unknown;
    size: number;
  }) {
    dotRenderCount += 1;
    return <span data-testid="dot" data-color={String(props.color)} />;
  }),
}));

import { listen } from "@tauri-apps/api/event";
import { shellStore } from "../../persistence/shellStore";
import { LedTwinOverlay } from "../ui/LedTwinOverlay";

type ListenCallback = (event: { payload: EdgeSignalPayload }) => void;

const CALIBRATION: LedCalibrationConfig = {
  counts: { top: 10, right: 6, bottom: 8, left: 6 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 30,
};

const EDGE_16: Array<[number, number, number]> = Array.from(
  { length: 16 },
  () => [0, 0, 0] as [number, number, number],
);

/** Fresh array instances every call — mirrors event deserialisation. */
function makeLeds(mutate?: (leds: Array<[number, number, number]>) => void) {
  const leds = Array.from(
    { length: CALIBRATION.totalLeds },
    () => [10, 20, 30] as [number, number, number],
  );
  mutate?.(leds);
  return leds;
}

function makeFrame(leds: Array<[number, number, number]>, seq: number): EdgeSignalPayload {
  return {
    top: EDGE_16,
    bottom: EDGE_16,
    left: EDGE_16,
    right: EDGE_16,
    leds,
    ledCount: leds.length,
    hueChannels: [],
    source: "test",
    pattern: "solid",
    seq,
  };
}

describe("LedTwinOverlay dot memoization", () => {
  let capturedCallback: ListenCallback | null;

  beforeEach(() => {
    dotRenderCount = 0;
    capturedCallback = null;
    (listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, callback: ListenCallback) => {
        capturedCallback = callback;
        return Promise.resolve(vi.fn());
      },
    );
    (shellStore.load as ReturnType<typeof vi.fn>).mockResolvedValue({
      ledCalibration: CALIBRATION,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function mountWithFirstFrame() {
    const view = render(<LedTwinOverlay scope="test" />);
    // Wait for the async calibration load to place the dots.
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-testid="dot"]')).toHaveLength(
        CALIBRATION.totalLeds,
      );
    });
    await act(async () => {
      capturedCallback?.({ payload: makeFrame(makeLeds(), 1) });
    });
    return view;
  }

  it("re-renders zero dots when the next frame carries identical colours", async () => {
    await mountWithFirstFrame();
    const baseline = dotRenderCount;

    await act(async () => {
      capturedCallback?.({ payload: makeFrame(makeLeds(), 2) });
    });

    expect(dotRenderCount).toBe(baseline);
  });

  it("re-renders exactly one dot when a single LED changes colour", async () => {
    await mountWithFirstFrame();
    const baseline = dotRenderCount;

    await act(async () => {
      capturedCallback?.({
        payload: makeFrame(
          makeLeds((leds) => {
            leds[7] = [200, 100, 50];
          }),
          3,
        ),
      });
    });

    expect(dotRenderCount).toBe(baseline + 1);
  });

  it("keeps ribbon gradients tracking the live colour buffer", async () => {
    const view = await mountWithFirstFrame();
    const ribbonOf = () =>
      view.container.querySelector<HTMLElement>(".lm-twin-ribbon")?.style.background ?? "";

    expect(ribbonOf()).toContain("rgb(10, 20, 30)");

    await act(async () => {
      capturedCallback?.({
        payload: makeFrame(
          makeLeds((leds) => {
            for (let i = 0; i < leds.length; i += 1) leds[i] = [1, 2, 3];
          }),
          4,
        ),
      });
    });

    expect(ribbonOf()).toContain("rgb(1, 2, 3)");
  });

  // The horizontal ribbons are inset 5% each side so the vertical ones own the
  // corners. Feeding them raw viewport offsets shifted every colour inboard of
  // the dot it mirrors — 4.5% of the display width at the corners.
  it("spans horizontal ribbon gradients across the inset element, not the viewport", async () => {
    const view = await mountWithFirstFrame();
    const ribbons = view.container.querySelectorAll<HTMLElement>(".lm-twin-ribbon");

    // EDGE_ORDER renders top first, then right.
    const top = ribbons[0].style.background;
    expect(top).toContain("to right");
    // First stop pinned to the element's own 0%, last to its 100%.
    expect(top).toMatch(/to right,\s*rgb\([^)]*\)\s*0\.0%/);
    expect(top).toMatch(/rgb\([^)]*\)\s*100\.0%\)$/);

    // The vertical ribbons run the full height, so their stops stay in
    // viewport space and must NOT be remapped.
    const right = ribbons[1].style.background;
    expect(right).toContain("to bottom");
    expect(right).toContain("5.0%");
    expect(right).toContain("95.0%");
    expect(right).not.toContain("100.0%");
  });
});
