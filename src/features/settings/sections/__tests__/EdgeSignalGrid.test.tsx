/**
 * EdgeSignalGrid — subscription-gating and render-containment tests.
 *
 * The containment test is the F10 regression guard: the ~10 Hz edge-signal
 * state must stay in this leaf. Held one level up it re-rendered the whole
 * Lights section ten times a second.
 *
 * Covers:
 *   - No subscription while Ambilight is inactive.
 *   - Subscribes on activation and unlistens when it goes inactive again.
 *   - Streamed samples become per-edge gradient backgrounds.
 *   - A parent component does NOT re-render when frames arrive.
 */

import { render, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EdgeSignalPayload } from "@/features/mode/model/contracts";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { listen } from "@tauri-apps/api/event";
import { EdgeSignalGrid } from "../EdgeSignalGrid";

type ListenCallback = (event: { payload: EdgeSignalPayload }) => void;

function edgeSamples(color: [number, number, number], count = 4) {
  return Array.from({ length: count }, () => [...color] as [number, number, number]);
}

function makePayload(color: [number, number, number]): EdgeSignalPayload {
  return {
    top: edgeSamples(color),
    bottom: edgeSamples(color),
    left: edgeSamples(color),
    right: edgeSamples(color),
  };
}

let parentRenderCount = 0;

function Parent({ isAmbilight }: { isAmbilight: boolean }) {
  parentRenderCount += 1;
  return (
    <EdgeSignalGrid
      isAmbilight={isAmbilight}
      counts={{ top: 10, right: 6, bottom: 8, left: 6 }}
      displayIndex={1}
      resolutionLabel="1920 × 1080"
    />
  );
}

describe("EdgeSignalGrid", () => {
  let capturedCallback: ListenCallback | null;
  let unlistenMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    parentRenderCount = 0;
    capturedCallback = null;
    unlistenMock = vi.fn();
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

  it("does not subscribe while Ambilight is inactive", () => {
    render(<Parent isAmbilight={false} />);
    expect(listen).not.toHaveBeenCalled();
  });

  it("subscribes on activation and unlistens when Ambilight goes inactive", async () => {
    const { rerender } = render(<Parent isAmbilight />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

    rerender(<Parent isAmbilight={false} />);
    await waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));
  });

  it("paints streamed samples as per-edge gradient backgrounds", async () => {
    const { container } = render(<Parent isAmbilight />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

    await act(async () => {
      capturedCallback?.({ payload: makePayload([9, 8, 7]) });
    });

    const top = container.querySelector<HTMLElement>(".lm-edge-top");
    expect(top?.style.background).toContain("rgb(9,8,7)");
    expect(top?.style.background).toContain("linear-gradient(to right");

    const left = container.querySelector<HTMLElement>(".lm-edge-l");
    expect(left?.style.background).toContain("linear-gradient(to bottom");
  });

  it("keeps frame-rate re-renders out of the parent", async () => {
    render(<Parent isAmbilight />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    const baseline = parentRenderCount;

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        capturedCallback?.({ payload: makePayload([i, i, i]) });
      });
    }

    expect(parentRenderCount).toBe(baseline);
  });
});
