import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThrottledCommit } from "@/shared/lib/useThrottledCommit";

import { RangeRow } from "../RangeRow";

/** A brightness row's wiring: local value, throttled commit, flush on release. */
function ThrottledRow({ onCommit }: { onCommit: (value: number) => void }) {
  const [value, setValue] = useState(50);
  const throttle = useThrottledCommit(onCommit, 50);
  return (
    <RangeRow
      variant="stage"
      label="Brightness"
      valueLabel={`${value}%`}
      min={0}
      max={100}
      step={1}
      value={value}
      onDragEnd={() => throttle.flush()}
      onChange={(next) => {
        setValue(next);
        throttle.push(next);
      }}
    />
  );
}

describe("RangeRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the slider and shows its readout", () => {
    render(<ThrottledRow onCommit={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Brightness" });
    expect(slider).toHaveValue("50");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("throttles a drag and commits the value it was released on", () => {
    const onCommit = vi.fn();
    render(<ThrottledRow onCommit={onCommit} />);
    const slider = screen.getByRole("slider");

    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "60" } });
    fireEvent.change(slider, { target: { value: "70" } });
    fireEvent.change(slider, { target: { value: "80" } });
    expect(onCommit.mock.calls).toEqual([[60]]);
    expect(screen.getByText("80%")).toBeInTheDocument();

    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenLastCalledWith(80);

    act(() => vi.advanceTimersByTime(100));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("draws the fill from the value's place in the range, not the raw number", () => {
    render(
      <RangeRow
        variant="stage"
        label="Saturation"
        valueLabel="125%"
        min={50}
        max={200}
        step={1}
        value={125}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("slider").style.getPropertyValue("--fill")).toBe("50%");
  });

  it("ties the dock label to its slider", () => {
    render(
      <RangeRow variant="dock" label="Opacity" valueLabel="40%" min={0} max={100} step={1} value={40} onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Opacity")).toBe(screen.getByRole("slider"));
  });
});

describe("RangeRow — a value set from outside", () => {
  function Row({ value, label = "Width" }: { value: number; label?: string }) {
    return (
      <RangeRow
        variant="stage"
        label={label}
        valueLabel={`${value}%`}
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={() => {}}
        testId="row"
      />
    );
  }
  const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

  it("glides there from where it was, and its readout comes in anew; the page opening moves nothing", async () => {
    // The clock is the test's: frames here arrive too late to see a glide by the wall clock.
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const view = render(<Row value={20} />);
    expect(screen.getByText("20%")).not.toHaveAttribute("data-swapped");
    view.rerender(<Row value={80} />);
    expect(screen.getByText("80%")).toHaveAttribute("data-swapped");
    // The first paint is still where it was.
    expect(screen.getByTestId("row")).toHaveValue("20");
    now += 120;
    await frame();
    const mid = Number((screen.getByTestId("row") as HTMLInputElement).value);
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(80);
    now += 200;
    await frame();
    expect(screen.getByTestId("row")).toHaveValue("80");
    expect(screen.getByTestId("row").style.getPropertyValue("--fill")).toBe("80%");
    vi.restoreAllMocks();
  });

  it("fades a new name in, as when another effect calls the same row something else", () => {
    const view = render(<Row value={50} label="Width" />);
    expect(screen.getByText("Width")).not.toHaveAttribute("data-swapped");
    view.rerender(<Row value={50} label="Scale" />);
    expect(screen.getByText("Scale")).toHaveAttribute("data-swapped");
  });

  it("follows a drag untouched: no glide, no readout coming in", async () => {
    function Dragged() {
      const [value, setValue] = useState(50);
      return (
        <RangeRow variant="stage" label="Speed" valueLabel={`${value}%`} min={0} max={100} step={1} value={value} onChange={setValue} testId="row" />
      );
    }
    render(<Dragged />);
    fireEvent.change(screen.getByTestId("row"), { target: { value: "70" } });
    expect(screen.getByText("70%")).not.toHaveAttribute("data-swapped");
    await frame();
    expect(screen.getByTestId("row")).toHaveValue("70");
  });
});
