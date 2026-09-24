import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThrottledCommit } from "@/shared/lib/useThrottledCommit";

import { RangeRow } from "../RangeRow";

/** The compact brightness row's wiring: local value, throttled commit, flush on release. */
function ThrottledRow({ onCommit }: { onCommit: (value: number) => void }) {
  const [value, setValue] = useState(50);
  const throttle = useThrottledCommit(onCommit, 50);
  return (
    <RangeRow
      variant="compact"
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

  it("draws the profile fill from the value's place in the range, not the raw number", () => {
    const { container } = render(
      <RangeRow
        variant="profile"
        label="Saturation"
        valueLabel="125%"
        min={50}
        max={200}
        step={1}
        value={125}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector<HTMLElement>(".tr-fill")?.style.width).toBe("50%");
  });

  it("ties the dock label to its slider", () => {
    render(
      <RangeRow variant="dock" label="Opacity" valueLabel="40%" min={0} max={100} step={1} value={40} onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Opacity")).toBe(screen.getByRole("slider"));
  });
});
