/**
 * LedTwinOverlay — memo bail-out regression tests.
 *
 * The defect these guard: `colorAt` used to hand each dot `frame.leds[i]`, a
 * freshly decoded array on every frame, so `LedGlowDot`'s shallow memo
 * compare never matched and all N dots re-rendered per frame.
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
 *   - A frame is drawn only against the layout it was cut for.
 */

import { render, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo } from "react";

import { TWIN_FRAME, type TwinLayout } from "@/shared/contracts/preview";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type * as previewApiModule from "../previewApi";

let dotRenderCount = 0;

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let onFrame: ((frame: ArrayBuffer) => void) | null = null;
let answeredLayout: TwinLayout | null = null;
/** Frames Rust sends while the subscribe is still being answered. */
let framesDuringSubscribe: ArrayBuffer[] = [];
const subscribeTwinFrames = vi.fn<typeof previewApiModule.subscribeTwinFrames>((handler) => {
  onFrame = handler;
  for (const frame of framesDuringSubscribe) handler(frame);
  return Promise.resolve({
    layout: answeredLayout,
    status: { code: "PREVIEW_TWIN_SUBSCRIBED", message: "", details: null },
  });
});
vi.mock("../previewApi", () => ({
  subscribeTwinFrames: (...args: Parameters<typeof subscribeTwinFrames>) => subscribeTwinFrames(...args),
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
import { LedTwinOverlay } from "../ui/LedTwinOverlay";

type ListenCallback = (event: { payload: TwinLayout }) => void;

const CALIBRATION: LedCalibrationConfig = {
  counts: { top: 10, right: 6, bottom: 8, left: 6 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 30,
};

/** Fresh array instances every call — mirrors event deserialisation. */
function makeLeds(mutate?: (leds: Array<[number, number, number]>) => void) {
  const leds = Array.from(
    { length: CALIBRATION.totalLeds },
    () => [10, 20, 30] as [number, number, number],
  );
  mutate?.(leds);
  return leds;
}

function makeFrame(leds: Array<[number, number, number]>, seq: number, revision = 1): ArrayBuffer {
  const buffer = new ArrayBuffer(TWIN_FRAME.HEADER_BYTES + leds.length * 3);
  const view = new DataView(buffer);
  view.setUint32(TWIN_FRAME.SEQ_OFFSET, seq, true);
  view.setUint32(TWIN_FRAME.REVISION_OFFSET, revision, true);
  view.setUint32(TWIN_FRAME.LED_COUNT_OFFSET, leds.length, true);
  view.setUint32(TWIN_FRAME.LAMP_COUNT_OFFSET, 0, true);
  new Uint8Array(buffer, TWIN_FRAME.HEADER_BYTES).set(leds.flat());
  return buffer;
}

const LAYOUT: TwinLayout = { displayId: "display-1", layoutRevision: 1, leds: CALIBRATION };

describe("LedTwinOverlay dot memoization", () => {
  let layoutListener: ListenCallback | null;
  const send = (frame: ArrayBuffer) => onFrame?.(frame);

  beforeEach(() => {
    dotRenderCount = 0;
    layoutListener = null;
    onFrame = null;
    answeredLayout = LAYOUT;
    framesDuringSubscribe = [];
    (listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, callback: ListenCallback) => {
        layoutListener = callback;
        return Promise.resolve(vi.fn());
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function mountWithFirstFrame() {
    const view = render(<LedTwinOverlay />);
    // Wait for the subscribe answer to place the dots.
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-testid="dot"]')).toHaveLength(
        CALIBRATION.totalLeds,
      );
    });
    await act(async () => {
      send(makeFrame(makeLeds(), 1));
    });
    return view;
  }

  it("opts its window out of the app's dark color-scheme so it stays clear", async () => {
    document.documentElement.style.colorScheme = "";
    await mountWithFirstFrame();

    expect(document.documentElement.style.background).toBe("transparent");
    expect(document.documentElement.style.colorScheme).toBe("normal");
    document.documentElement.style.cssText = "";
    document.body.style.cssText = "";
  });

  it("re-renders zero dots when the next frame carries identical colours", async () => {
    await mountWithFirstFrame();
    const baseline = dotRenderCount;

    await act(async () => {
      send(makeFrame(makeLeds(), 2));
    });

    expect(dotRenderCount).toBe(baseline);
  });

  it("re-renders exactly one dot when a single LED changes colour", async () => {
    await mountWithFirstFrame();
    const baseline = dotRenderCount;

    await act(async () => {
      send(makeFrame(
          makeLeds((leds) => {
            leds[7] = [200, 100, 50];
          }),
          3,
        ));
    });

    expect(dotRenderCount).toBe(baseline + 1);
  });

  it("keeps ribbon gradients tracking the live colour buffer", async () => {
    const view = await mountWithFirstFrame();
    const ribbonOf = () =>
      view.container.querySelector<HTMLElement>(".lm-twin-ribbon")?.style.background ?? "";

    expect(ribbonOf()).toContain("rgb(10, 20, 30)");

    await act(async () => {
      send(makeFrame(
          makeLeds((leds) => {
            for (let i = 0; i < leds.length; i += 1) leds[i] = [1, 2, 3];
          }),
          4,
        ));
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

  it("draws the frame Rust sent while the subscribe was being answered", async () => {
    framesDuringSubscribe = [makeFrame(makeLeds(() => {}).map(() => [9, 9, 9] as [number, number, number]), 1)];
    const view = render(<LedTwinOverlay />);

    await waitFor(() => {
      expect(view.container.querySelector<HTMLElement>(".lm-twin-ribbon")?.style.background).toContain(
        "rgb(9, 9, 9)",
      );
    });
  });

  it("ignores a frame cut for a layout it no longer draws", async () => {
    const view = await mountWithFirstFrame();
    const ribbonOf = () =>
      view.container.querySelector<HTMLElement>(".lm-twin-ribbon")?.style.background ?? "";

    await act(async () => {
      layoutListener?.({ payload: { ...LAYOUT, layoutRevision: 2 } });
    });
    await act(async () => {
      send(makeFrame(makeLeds((leds) => leds.fill([7, 7, 7])), 5, 1));
    });
    expect(ribbonOf()).not.toContain("rgb(7, 7, 7)");

    await act(async () => {
      send(makeFrame(makeLeds((leds) => leds.fill([7, 7, 7])), 6, 2));
    });
    expect(ribbonOf()).toContain("rgb(7, 7, 7)");
  });
});
