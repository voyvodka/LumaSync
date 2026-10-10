/**
 * LedTwinOverlay — what reaches the canvas, and when.
 *
 * The canvas is faked with a context that records each paint's colours, so a
 * test can say a frame was drawn, was not redrawn when nothing changed, and
 * was refused when it belongs to a layout the twin no longer draws.
 */

import { render, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TWIN_FRAME, type TwinLayout } from "@/shared/contracts/preview";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type * as previewApiModule from "../previewApi";

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

import { listen } from "@tauri-apps/api/event";
import { LedTwinOverlay } from "../ui/LedTwinOverlay";

type ListenCallback = (event: { payload: TwinLayout }) => void;

/** Every dot paint, as the colour of its centre stop, per canvas paint. */
let dotPaints: string[][] = [];

function fakeContext() {
  let current: string[] | null = null;
  let style: { first?: string } = {};
  return {
    setTransform: () => {},
    clearRect(this: { canvas: HTMLCanvasElement }) {
      current = [];
      if (this.canvas.dataset.testid === "twin-dots") dotPaints.push(current);
    },
    fillRect(this: { canvas: HTMLCanvasElement }) {
      if (this.canvas.dataset.testid === "twin-dots" && style.first) current?.push(style.first);
    },
    set fillStyle(value: { first?: string }) {
      style = value;
    },
    get fillStyle() {
      return style;
    },
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => {
      const gradient: { first?: string; addColorStop: (offset: number, colour: string) => void } = {
        addColorStop(offset, colour) {
          if (offset === 0) gradient.first = colour;
        },
      };
      return gradient;
    },
  };
}

const CALIBRATION: LedCalibrationConfig = {
  counts: { top: 10, right: 6, bottom: 8, left: 6 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 30,
};

const LAYOUT: TwinLayout = { displayId: "display-1", layoutRevision: 1, leds: CALIBRATION };

function makeLeds(colour: [number, number, number] = [10, 20, 30]) {
  return Array.from({ length: CALIBRATION.totalLeds }, () => colour);
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

const lastPaint = () => dotPaints[dotPaints.length - 1] ?? [];

describe("LedTwinOverlay", () => {
  let layoutListener: ListenCallback | null;
  const send = (frame: ArrayBuffer) => onFrame?.(frame);

  beforeEach(() => {
    dotPaints = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return Object.assign(fakeContext(), { canvas: this }) as unknown as CanvasRenderingContext2D;
    });
    layoutListener = null;
    onFrame = null;
    answeredLayout = LAYOUT;
    framesDuringSubscribe = [];
    (listen as ReturnType<typeof vi.fn>).mockImplementation((_event: string, callback: ListenCallback) => {
      layoutListener = callback;
      return Promise.resolve(vi.fn());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountWithFirstFrame() {
    const view = render(<LedTwinOverlay />);
    await waitFor(() => expect(lastPaint()).toHaveLength(CALIBRATION.totalLeds));
    await act(async () => {
      send(makeFrame(makeLeds(), 1));
    });
    await waitFor(() => expect(lastPaint()[0]).toBe("rgba(10, 20, 30, 0.95)"));
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

  it("does not repaint for a frame with the same colours", async () => {
    await mountWithFirstFrame();
    const paints = dotPaints.length;

    await act(async () => {
      send(makeFrame(makeLeds(), 2));
    });

    expect(dotPaints).toHaveLength(paints);
  });

  it("repaints with the new colour when one LED changes", async () => {
    await mountWithFirstFrame();
    const leds = makeLeds();
    leds[7] = [200, 100, 50];

    await act(async () => {
      send(makeFrame(leds, 3));
    });

    expect(lastPaint().filter((colour) => colour === "rgba(200, 100, 50, 0.95)")).toHaveLength(1);
  });

  it("draws the frame Rust sent while the subscribe was being answered", async () => {
    framesDuringSubscribe = [makeFrame(makeLeds([9, 9, 9]), 1)];
    render(<LedTwinOverlay />);

    await waitFor(() => expect(lastPaint()[0]).toBe("rgba(9, 9, 9, 0.95)"));
  });

  it("ignores a frame cut for a layout it no longer draws", async () => {
    await mountWithFirstFrame();

    await act(async () => {
      layoutListener?.({ payload: { ...LAYOUT, layoutRevision: 2 } });
    });
    await act(async () => {
      send(makeFrame(makeLeds([7, 7, 7]), 5, 1));
    });
    expect(lastPaint()).not.toContain("rgba(7, 7, 7, 0.95)");

    await act(async () => {
      send(makeFrame(makeLeds([7, 7, 7]), 6, 2));
    });
    expect(lastPaint()[0]).toBe("rgba(7, 7, 7, 0.95)");
  });
});
