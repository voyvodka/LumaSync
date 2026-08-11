/**
 * useLedPreviewFrame — event-filtering and listener cleanup tests.
 *
 * Covers:
 *   - Frames that carry no per-LED `leds` buffer are silently ignored.
 *   - Enriched frames are accepted when no displayId filter is configured.
 *   - Frames whose payload.displayId matches the hook filter are accepted.
 *   - Frames whose payload.displayId mismatches the filter are dropped.
 *   - Test-source frames with no displayId pass through even when the hook
 *     carries a displayId filter (filter only fires when BOTH sides name one).
 *   - Optional enrichment fields (seq, hueChannels, ledCount) are mapped.
 *   - `ledCount` falls back to `leds.length` when absent from the payload.
 *   - The subscription targets the EDGE_SIGNAL_EVENT channel.
 *   - The unlisten function is invoked on unmount (no listener leak).
 */

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EdgeSignalPayload } from "../../mode/model/contracts";
import { EDGE_SIGNAL_EVENT } from "../../mode/model/contracts";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/event BEFORE the imports that depend on it.
// vi.mock is hoisted — the factory runs before any import is evaluated.
// ---------------------------------------------------------------------------
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import { useLedPreviewFrame } from "../state/useLedPreviewFrame";

// ---------------------------------------------------------------------------
// Local types + helpers
// ---------------------------------------------------------------------------

/** Minimal callback shape captured from the `listen` call. */
type ListenCallback = (event: { payload: EdgeSignalPayload }) => void;

/** Sixteen samples per edge — matches EDGE_SIGNAL_SAMPLES_PER_EDGE. */
const EDGE_16: Array<[number, number, number]> = Array.from(
  { length: 16 },
  () => [100, 100, 100] as [number, number, number],
);

/** Build a fully enriched EdgeSignalPayload with optional overrides. */
function makeEnrichedPayload(
  overrides: Partial<EdgeSignalPayload> = {},
): EdgeSignalPayload {
  const leds: Array<[number, number, number]> = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];
  return {
    top: EDGE_16,
    bottom: EDGE_16,
    left: EDGE_16,
    right: EDGE_16,
    leds,
    ledCount: leds.length,
    hueChannels: [[200, 200, 200]],
    source: "test",
    pattern: "solid",
    seq: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLedPreviewFrame", () => {
  let capturedCallback: ListenCallback | null;
  let unlistenMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedCallback = null;
    unlistenMock = vi.fn();

    // Capture the listener callback synchronously; return the unlisten fn
    // as a resolved promise so the hook's .then() path stores it.
    (listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_event: string, callback: ListenCallback) => {
        capturedCallback = callback;
        return Promise.resolve(unlistenMock);
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — lean frame (no leds) is ignored
  // -------------------------------------------------------------------------
  it("ignores frames that carry no leds buffer", async () => {
    const { result } = renderHook(() => useLedPreviewFrame());
    await act(async () => {});

    act(() => {
      capturedCallback?.({
        payload: { top: EDGE_16, bottom: EDGE_16, left: EDGE_16, right: EDGE_16 },
      });
    });

    expect(result.current).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — enriched frame accepted when no displayId filter is set
  // -------------------------------------------------------------------------
  it("accepts an enriched frame when no displayId filter is configured", async () => {
    const { result } = renderHook(() => useLedPreviewFrame());
    await act(async () => {});

    act(() => {
      capturedCallback?.({ payload: makeEnrichedPayload() });
    });

    expect(result.current).not.toBeNull();
    expect(result.current?.leds).toHaveLength(3);
    expect(result.current?.source).toBe("test");
    expect(result.current?.pattern).toBe("solid");
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — matching displayId passes the filter
  // -------------------------------------------------------------------------
  it("accepts a live frame when the payload displayId matches the hook filter", async () => {
    const { result } = renderHook(() => useLedPreviewFrame("display-1"));
    await act(async () => {});

    act(() => {
      capturedCallback?.({
        payload: makeEnrichedPayload({ displayId: "display-1", source: "live" }),
      });
    });

    expect(result.current).not.toBeNull();
    expect(result.current?.source).toBe("live");
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — mismatched displayId is dropped
  // -------------------------------------------------------------------------
  it("filters out a frame when the payload displayId does not match the hook filter", async () => {
    const { result } = renderHook(() => useLedPreviewFrame("display-1"));
    await act(async () => {});

    act(() => {
      capturedCallback?.({
        payload: makeEnrichedPayload({ displayId: "display-2" }),
      });
    });

    expect(result.current).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — test-source frame with no displayId passes even with filter
  //
  // Phase 1 test frames are display-agnostic (they are synthetic, not sampled
  // from a screen). The hook contract: filter only when BOTH sides name a
  // displayId. When the payload omits displayId, the frame must pass through.
  // -------------------------------------------------------------------------
  it("accepts a test-source frame with no displayId even when the hook has a displayId filter", async () => {
    const { result } = renderHook(() => useLedPreviewFrame("display-1"));
    await act(async () => {});

    act(() => {
      // displayId deliberately absent (synthetic test pattern, display-agnostic)
      capturedCallback?.({
        payload: makeEnrichedPayload({ displayId: undefined, source: "test" }),
      });
    });

    expect(result.current).not.toBeNull();
    expect(result.current?.source).toBe("test");
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — optional enrichment fields are mapped
  // -------------------------------------------------------------------------
  it("maps seq, hueChannels, and ledCount from the payload", async () => {
    const { result } = renderHook(() => useLedPreviewFrame());
    await act(async () => {});

    const channels: Array<[number, number, number]> = [[1, 2, 3], [4, 5, 6]];
    act(() => {
      capturedCallback?.({
        payload: makeEnrichedPayload({ seq: 99, hueChannels: channels }),
      });
    });

    expect(result.current?.seq).toBe(99);
    expect(result.current?.hueChannels).toEqual(channels);
    expect(result.current?.ledCount).toBe(3); // 3 leds in makeEnrichedPayload
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — ledCount falls back to leds.length when absent
  // -------------------------------------------------------------------------
  it("falls back to leds.length as ledCount when the payload omits ledCount", async () => {
    const { result } = renderHook(() => useLedPreviewFrame());
    await act(async () => {});

    const leds: Array<[number, number, number]> = [[10, 20, 30], [40, 50, 60]];
    act(() => {
      capturedCallback?.({
        payload: makeEnrichedPayload({ leds, ledCount: undefined }),
      });
    });

    expect(result.current?.ledCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — correct event channel
  // -------------------------------------------------------------------------
  it("subscribes to the EDGE_SIGNAL_EVENT channel", async () => {
    renderHook(() => useLedPreviewFrame());
    await act(async () => {});

    expect(listen).toHaveBeenCalledWith(EDGE_SIGNAL_EVENT, expect.any(Function));
  });

  // -------------------------------------------------------------------------
  // Scenario 9 — unlisten called on unmount (listener leak prevention)
  // -------------------------------------------------------------------------
  it("invokes the unlisten function when the hook unmounts", async () => {
    const { unmount } = renderHook(() => useLedPreviewFrame());
    // Flush the promise chain so the unlisten fn is stored inside the hook.
    await act(async () => {});

    unmount();

    expect(unlistenMock).toHaveBeenCalledOnce();
  });
});
