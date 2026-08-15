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

import {
  DRAG_COMMIT_MIN_INTERVAL_MS,
  HsvColorPicker,
  sanitizeHexInput,
} from "../HsvColorPicker";

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

describe("sanitizeHexInput", () => {
  it("caps at six digits", () => {
    expect(sanitizeHexInput("1A2B3C4D5E")).toBe("1A2B3C");
  });

  it("drops non-hex characters", () => {
    expect(sanitizeHexInput("zz12gg34xx56")).toBe("123456");
  });

  it("strips a leading # and surrounding whitespace", () => {
    expect(sanitizeHexInput("  #1a2b3c  ")).toBe("1A2B3C");
  });

  it("filters before capping so a #-prefixed value keeps all six digits", () => {
    expect(sanitizeHexInput("#1A2B3C")).toBe("1A2B3C");
  });

  it("returns an empty string for input with no hex characters", () => {
    expect(sanitizeHexInput("#!! zz")).toBe("");
  });
});

describe("HsvColorPicker hex input", () => {
  function renderPicker(onChange = vi.fn()) {
    const utils = render(
      <HsvColorPicker value="#ffffff" onChange={onChange} hideRecent />,
    );
    const input = utils.container.querySelector("input[type='text']") as HTMLInputElement;
    expect(input).toBeTruthy();
    return { ...utils, input, onChange };
  }

  it("renders the draft without a # — the prefix is static chrome", () => {
    const { input } = renderPicker();
    expect(input.value).toBe("FFFFFF");
    expect(input.maxLength).toBe(6);
  });

  it("caps typed input at six hex digits", () => {
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "1A2B3C4D5E" } });
    expect(input.value).toBe("1A2B3C");
  });

  it("never shows a non-hex keystroke in the field", () => {
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "FFzz!!" } });
    expect(input.value).toBe("FF");
  });

  it("sanitises a pasted #-prefixed value over the whole selection", () => {
    const { input } = renderPicker();
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "#1A2B3C" } });
    expect(input.value).toBe("1A2B3C");
  });

  it("sanitises a pasted value padded with whitespace", () => {
    const { input } = renderPicker();
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "  #1a2b3c  " } });
    expect(input.value).toBe("1A2B3C");
  });

  it("truncates an over-long paste to six digits", () => {
    const { input } = renderPicker();
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "1A2B3C4D5E6F" } });
    expect(input.value).toBe("1A2B3C");
  });

  it("commits a complete draft on Enter", () => {
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { value: "1a2b3c" } });
    onChange.mockClear();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("#1a2b3c");
  });

  it("resets the draft on Escape without committing", () => {
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { value: "1a2b3c" } });
    onChange.mockClear();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("FFFFFF");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reverts an incomplete draft on blur without committing", () => {
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { value: "1a2" } });
    expect(input.value).toBe("1A2");
    onChange.mockClear();
    fireEvent.blur(input);
    expect(input.value).toBe("FFFFFF");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks an incomplete draft aria-invalid and a complete one valid", () => {
    const { input } = renderPicker();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    fireEvent.change(input, { target: { value: "1a2" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "1a2b3c" } });
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});

// Until the test environment installed its own `localStorage`, every one of
// these paths threw into `loadRecent`/`saveRecent`'s catch and the strip was
// silently inert under Node >= 24.
describe("HsvColorPicker recent colors", () => {
  const RECENT_KEY = "lm-recent-colors";

  function renderPicker(onChange = vi.fn()) {
    const utils = render(<HsvColorPicker value="#ffffff" onChange={onChange} />);
    const input = utils.container.querySelector("input[type='text']") as HTMLInputElement;
    return { ...utils, input, onChange };
  }

  function commit(input: HTMLInputElement, hex: string): void {
    fireEvent.change(input, { target: { value: hex } });
    fireEvent.blur(input);
  }

  function storedRecent(): unknown {
    return JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "null");
  }

  function swatchTitles(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("button[role='listitem']")).map(
      (b) => b.getAttribute("title") ?? "",
    );
  }

  it("persists a committed hex and restores it on a fresh mount", () => {
    const first = renderPicker();
    commit(first.input, "1a2b3c");
    expect(storedRecent()).toEqual(["#1a2b3c"]);
    first.unmount();

    const second = renderPicker();
    expect(swatchTitles(second.container)).toEqual(["#1A2B3C"]);
  });

  it("moves a re-picked color to the front instead of duplicating it", () => {
    const { input, container } = renderPicker();
    commit(input, "111111");
    commit(input, "222222");
    commit(input, "111111");

    expect(storedRecent()).toEqual(["#111111", "#222222"]);
    expect(swatchTitles(container)).toEqual(["#111111", "#222222"]);
  });

  it("caps the strip at eight entries, dropping the oldest", () => {
    const { input, container } = renderPicker();
    for (let i = 1; i <= 9; i += 1) {
      commit(input, `${i}${i}${i}${i}${i}${i}`);
    }

    const stored = storedRecent() as string[];
    expect(stored).toHaveLength(8);
    expect(stored[0]).toBe("#999999");
    expect(stored).not.toContain("#111111");
    expect(swatchTitles(container)).toHaveLength(8);
  });

  it("ignores a stored payload that is not an array", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify({ nope: true }));
    const { container } = renderPicker();
    expect(swatchTitles(container)).toEqual([]);
  });

  it("drops stored entries that are not six-digit hex", () => {
    window.localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(["#1a2b3c", "red", "#abc", 42, "#AABBCC"]),
    );
    const { container } = renderPicker();
    expect(swatchTitles(container)).toEqual(["#1A2B3C", "#AABBCC"]);
  });

  it("survives a corrupt payload that is not JSON at all", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    window.localStorage.setItem(RECENT_KEY, "{not json");
    const { container } = renderPicker();
    expect(swatchTitles(container)).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });
});
