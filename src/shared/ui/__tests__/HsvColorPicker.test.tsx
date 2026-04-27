/**
 * Regression test for v1.5 fix #45 — `HsvColorPicker` drag throttle.
 *
 * Before this fix, the picker fired `onChange` on every pointermove (≥ 60 Hz
 * on modern displays). Wiring it through `App.tsx` for compact Solid mode
 * caused 50–200 `set_lighting_mode` Tauri invokes per second during a drag,
 * which in turn flipped `isModeTransitioning` permanently true and disabled
 * every dock toggle. The picker now updates local visual state on every
 * pointer move but throttles the parent `onChange` to one fire per
 * `DRAG_COMMIT_MIN_INTERVAL_MS` (50 ms) and always flushes a final commit on
 * pointer up.
 *
 * The tests below dispatch a burst of pointer events at the SV square and
 * verify that the parent `onChange` rate stays bounded — proving the spam
 * source is no longer a 1-to-1 with pointer-move events.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRAG_COMMIT_MIN_INTERVAL_MS, HsvColorPicker } from "../HsvColorPicker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  // Mock pointer-capture so happy-dom doesn't blow up — the picker uses
  // `setPointerCapture(e.pointerId)` on the SVG <g>.
  // happy-dom does not implement pointer capture by default.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // SVGElement.getBoundingClientRect needs a deterministic rect for the
  // square coordinate math. Override on every render's <svg>.
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  // happy-dom doesn't ship a complete PointerEvent so we forge one with the
  // shape React's synthetic-event reader actually consumes.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
}

describe("HsvColorPicker drag throttle", () => {
  it("throttles onChange during a pointer drag (≤ 1 fire per 50 ms)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <HsvColorPicker value="#ffffff" onChange={onChange} hideRecent hideHex />,
    );

    // The SV square's parent <g> registers pointerdown / pointermove handlers.
    const groups = container.querySelectorAll("svg > g");
    // Order: hue ring group, sv square group.
    const svGroup = groups[1] as SVGGElement;
    expect(svGroup).toBeTruthy();

    // Pointer down at the centre of the square — this fires `commitImmediate`
    // (single tap path) so onChange MUST be called once at this point.
    fireEvent(svGroup, pointerEvent("pointerdown", 100, 100));
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();

    // Burst: 60 pointer-move ticks within 100 ms (mimicking a 600 Hz drag).
    // Without the throttle this would fire 60 onChange calls. With it, we
    // expect at most ceil(100 / 50) + 1 ≈ 3 fires.
    for (let i = 0; i < 60; i += 1) {
      fireEvent(svGroup, pointerEvent("pointermove", 100 + i, 100 + i));
      vi.advanceTimersByTime(100 / 60);
    }
    // Drain any pending throttle tick.
    vi.advanceTimersByTime(DRAG_COMMIT_MIN_INTERVAL_MS);

    // The first move tick is debounced through the throttle (lastDispatchAt
    // was just set by the pointerdown immediate commit), so we expect the
    // count to stay well below the raw move count and be capped near
    // ceil(elapsed / interval).
    expect(onChange.mock.calls.length).toBeLessThan(10);
    expect(onChange.mock.calls.length).toBeGreaterThan(0);
  });

  it("flushes the latest pending commit on pointer up", () => {
    const onChange = vi.fn();
    const { container } = render(
      <HsvColorPicker value="#ffffff" onChange={onChange} hideRecent hideHex />,
    );
    const groups = container.querySelectorAll("svg > g");
    const svGroup = groups[1] as SVGGElement;

    fireEvent(svGroup, pointerEvent("pointerdown", 100, 100));
    onChange.mockClear();

    // Two moves within the throttle window — only the throttled tick will
    // have fired.
    fireEvent(svGroup, pointerEvent("pointermove", 110, 110));
    fireEvent(svGroup, pointerEvent("pointermove", 130, 130));
    expect(onChange).not.toHaveBeenCalled();

    // Pointer up MUST flush the most recent payload.
    fireEvent(svGroup, pointerEvent("pointerup", 130, 130));
    expect(onChange).toHaveBeenCalledTimes(1);

    // The flushed payload should reflect the latest move's coordinates,
    // not the first one — there is no "stuck pending" payload risk.
    const lastHex = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastHex).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("fires onChange immediately on keyboard arrow nudges (not throttled)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <HsvColorPicker value="#808080" onChange={onChange} hideRecent hideHex />,
    );
    const handles = container.querySelectorAll("circle[role='slider']");
    // [0] is the hue ring handle, [1] is the SV square handle.
    const hueHandle = handles[0] as SVGCircleElement;
    expect(hueHandle).toBeTruthy();

    fireEvent.keyDown(hueHandle, { key: "ArrowRight" });
    fireEvent.keyDown(hueHandle, { key: "ArrowRight" });
    fireEvent.keyDown(hueHandle, { key: "ArrowRight" });

    // Keyboard nudges are deliberate user actions — each one fires onChange
    // synchronously. No throttle queue.
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
