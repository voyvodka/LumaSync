import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DecimalField, parseDecimal } from "../DecimalField";

type Animate = (keyframes: Keyframe[], options: KeyframeAnimationOptions) => { finished: Promise<void> };
const animate = vi.fn<Animate>(() => ({ finished: Promise.resolve() }));

beforeEach(() => {
  animate.mockClear();
  (HTMLElement.prototype as unknown as { animate: Animate }).animate = animate;
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-reduced-motion");
});

function renderRequired(props: Partial<Parameters<typeof DecimalField>[0]> = {}) {
  const onCommit = vi.fn<(next: number) => void>();
  render(<DecimalField label="Width" value={1.2} min={0.1} max={5} unit="m" onCommit={onCommit} {...(props as object)} />);
  return { onCommit, input: screen.getByRole("spinbutton", { name: "Width" }) as HTMLInputElement };
}

function type(input: HTMLInputElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

describe("parseDecimal", () => {
  it("reads a point or a comma as the decimal mark, and nothing else as a number", () => {
    expect(parseDecimal("1.25")).toBe(1.25);
    expect(parseDecimal(" 1,25 ")).toBe(1.25);
    expect(parseDecimal("-0,5")).toBe(-0.5);
    expect(parseDecimal(".5")).toBe(0.5);
    expect(parseDecimal("1.2.3")).toBeNull();
    expect(parseDecimal("12m")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });
});

describe("DecimalField — typing", () => {
  it("applies on Enter and on leaving the field, as written with a comma", () => {
    const { onCommit, input } = renderRequired();
    type(input, "2,5");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenLastCalledWith(2.5, false);

    cleanup();
    const second = renderRequired();
    type(second.input, "3");
    fireEvent.blur(second.input);
    expect(second.onCommit).toHaveBeenLastCalledWith(3, false);
  });

  it("stores the number as it reads", () => {
    const { onCommit, input } = renderRequired();
    type(input, "1.234");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(1.23, false);
  });

  it("puts the value back on Escape", () => {
    const { onCommit, input } = renderRequired();
    type(input, "4");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("1.20");
  });

  it("puts the value back for a number out of range, with one small shake", () => {
    const { onCommit, input } = renderRequired();
    type(input, "9");
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("1.20");
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("does not shake under reduced motion", () => {
    document.documentElement.setAttribute("data-reduced-motion", "");
    const { input } = renderRequired();
    type(input, "9");
    fireEvent.blur(input);
    expect(animate).not.toHaveBeenCalled();
  });

  it("puts the value back for text that is not a number", () => {
    const { onCommit, input } = renderRequired();
    type(input, "wide");
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("1.20");
  });

  it("commits nothing when the number did not change", () => {
    const { onCommit, input } = renderRequired();
    fireEvent.focus(input);
    fireEvent.blur(input);
    type(input, "1.2");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows a value changed from outside while it is not being edited", () => {
    const onCommit = vi.fn<(next: number) => void>();
    const { rerender } = render(<DecimalField label="Width" value={1.2} onCommit={onCommit} />);
    rerender(<DecimalField label="Width" value={2} onCommit={onCommit} />);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("2.00");
  });
});

describe("DecimalField — arrow keys", () => {
  it("steps and applies at once, ten steps with Shift, held inside the range", () => {
    const { onCommit, input } = renderRequired({ step: 0.1 });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(1.3, false);
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(0.3, false);
    expect(input.value).toBe("0.30");

    cleanup();
    const top = renderRequired({ value: 4.95, step: 0.1 });
    fireEvent.keyDown(top.input, { key: "ArrowUp" });
    expect(top.onCommit).toHaveBeenLastCalledWith(5, false);
  });

  it("wraps through a normaliser, so a rotation steps from 359 to 0", () => {
    const onCommit = vi.fn<(next: number) => void>();
    render(
      <DecimalField
        label="Rotation"
        value={359}
        decimals={0}
        step={1}
        min={0}
        max={359}
        normalize={(d) => ((d % 360) + 360) % 360}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(0, false);
    type(input, "-90");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(270, false);
  });
});

describe("DecimalField — an optional value", () => {
  function renderOptional(value: number | undefined) {
    const onCommit = vi.fn<(next: number | undefined) => void>();
    render(
      <DecimalField optional label="Height" value={value} placeholder="0.75" min={0.1} max={3} step={0.05} onCommit={onCommit} />,
    );
    return { onCommit, input: screen.getByRole("spinbutton") as HTMLInputElement };
  }

  it("clears to the default, and an empty field left alone writes nothing", () => {
    const set = renderOptional(1.1);
    type(set.input, "");
    fireEvent.blur(set.input);
    expect(set.onCommit).toHaveBeenLastCalledWith(undefined, false);

    cleanup();
    const unset = renderOptional(undefined);
    fireEvent.focus(unset.input);
    fireEvent.blur(unset.input);
    expect(unset.onCommit).not.toHaveBeenCalled();
    expect(unset.input.placeholder).toBe("0.75");
  });

  it("steps from the default it shows when nothing is set", () => {
    const { onCommit, input } = renderOptional(undefined);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(0.8, false);
  });
});

describe("DecimalField — semantics", () => {
  it("is a named spin button that reads its value with the unit, and can be disabled", () => {
    const { input } = renderRequired({ disabled: true });
    expect(input).toHaveAttribute("aria-valuenow", "1.2");
    expect(input).toHaveAttribute("aria-valuemin", "0.1");
    expect(input).toHaveAttribute("aria-valuemax", "5");
    expect(input).toHaveAttribute("aria-valuetext", "1.20 m");
    expect(input).toBeDisabled();
  });

  it("keeps its keys from the editor around it", () => {
    const onKeyDown = vi.fn<() => void>();
    const onCommit = vi.fn<(next: number) => void>();
    render(
      <div onKeyDown={onKeyDown}>
        <DecimalField label="Width" value={1} onCommit={onCommit} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Backspace" });
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

// A value could only change by typing or an arrow key; a drag across the field now steps it.
describe("DecimalField — a drag across it", () => {
  it("steps the value a step per few pixels, ten with ⇧", () => {
    const { onCommit, input } = renderRequired({ step: 0.1 });
    const box = input.closest("label")!;
    fireEvent.pointerDown(box, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 112, pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith(1.5, true);
    fireEvent.pointerMove(box, { clientX: 104, shiftKey: true, pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith(2.2, true);
    fireEvent.pointerUp(box, { pointerId: 1 });
    expect(input).not.toHaveFocus();
  });

  it("types after a press that does not move", () => {
    const { onCommit, input } = renderRequired();
    const box = input.closest("label")!;
    fireEvent.pointerDown(box, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(box, { clientX: 101, pointerId: 1 });
    expect(input).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
