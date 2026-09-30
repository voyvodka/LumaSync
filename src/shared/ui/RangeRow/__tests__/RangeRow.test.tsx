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

describe("RangeRow — a drag the value given back has not caught up with", () => {
  afterEach(() => vi.useRealTimers());

  /** The value comes back from outside, behind the pointer, the way a lighting retune answers. */
  function Echoed({ echo, onChange }: { echo: number; onChange: (v: number) => void }) {
    return (
      <RangeRow
        variant="stage"
        label="Saturation"
        valueLabel={(v) => `${Math.round(v)}%`}
        min={0}
        max={200}
        step={1}
        value={echo}
        onChange={onChange}
        testId="row"
      />
    );
  }

  it("keeps the thumb and the readout on the user's value while older values come back", () => {
    const onChange = vi.fn<(v: number) => void>();
    const view = render(<Echoed echo={100} onChange={onChange} />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row);
    fireEvent.change(row, { target: { value: "140" } });
    fireEvent.change(row, { target: { value: "180" } });
    view.rerender(<Echoed echo={120} onChange={onChange} />);
    expect(row).toHaveValue("180");
    expect(screen.getByText("180%")).not.toHaveAttribute("data-swapped");
    fireEvent.pointerUp(row);
    view.rerender(<Echoed echo={150} onChange={onChange} />);
    expect(row).toHaveValue("180");
    // Caught up: the value is its own again, and nothing glided or came in anew on the way.
    view.rerender(<Echoed echo={180} onChange={onChange} />);
    expect(row).toHaveValue("180");
    expect(screen.getByText("180%")).not.toHaveAttribute("data-swapped");
  });

  it("gives way to the value given back when it never catches up", () => {
    vi.useFakeTimers();
    const view = render(<Echoed echo={100} onChange={() => {}} />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row);
    fireEvent.change(row, { target: { value: "180" } });
    fireEvent.pointerUp(row);
    // The lights settled elsewhere — clamped, or another window moved it.
    view.rerender(<Echoed echo={160} onChange={() => {}} />);
    expect(row).toHaveValue("180");
    act(() => vi.advanceTimersByTime(1300));
    act(() => vi.runAllTimers());
    expect(screen.getByText("160%")).toBeInTheDocument();
  });
});

describe("RangeRow — a neutral value", () => {
  function Neutral({ value, onChange = () => {} }: { value: number; onChange?: (v: number) => void }) {
    return (
      <RangeRow
        variant="stage"
        label="Saturation"
        valueLabel={(v) => `${Math.round(v)}%`}
        min={50}
        max={200}
        step={1}
        value={value}
        neutral={{ value: 100, label: "Back to 100%" }}
        onChange={onChange}
        testId="row"
      />
    );
  }

  it("is marked on the track and the readout takes the value back there, until it is there", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const onChange = vi.fn<(v: number) => void>();
    const view = render(<Neutral value={130} onChange={onChange} />);
    expect(view.container.querySelector("[style*='--at']")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to 100%" }));
    expect(onChange).toHaveBeenCalledWith(100);
    // It glides there at once, from where the thumb was.
    now += 120;
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const mid = Number((screen.getByTestId("row") as HTMLInputElement).value);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(130);
    view.rerender(<Neutral value={100} />);
    now += 400;
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.queryByRole("button", { name: "Back to 100%" })).toBeNull();
    expect(view.container.querySelector("[style*='--at']")).toBeNull();
    vi.restoreAllMocks();
  });

  it("settles a pointer drag near it into it, but lets the arrow keys step off it", () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Neutral value={120} onChange={onChange} />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row);
    fireEvent.change(row, { target: { value: "102" } });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.pointerUp(row);
    fireEvent.change(row, { target: { value: "101" } });
    expect(onChange).toHaveBeenLastCalledWith(101);
  });
});

describe("RangeRow — the hold's edges", () => {
  it("glides to the neutral value at once when its readout is pressed right after a drag", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    function Lagging({ value }: { value: number }) {
      return (
        <RangeRow
          variant="stage"
          label="Saturation"
          valueLabel={(v) => `${Math.round(v)}%`}
          min={50}
          max={200}
          step={1}
          value={value}
          neutral={{ value: 100, label: "Back to 100%" }}
          onChange={() => {}}
          testId="row"
        />
      );
    }
    const view = render(<Lagging value={120} />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row);
    fireEvent.change(row, { target: { value: "160" } });
    fireEvent.pointerUp(row);
    // The drag's value is still on its way back; the readout is pressed meanwhile.
    fireEvent.click(screen.getByRole("button", { name: "Back to 100%" }));
    now += 120;
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const mid = Number((row as HTMLInputElement).value);
    expect(mid).toBeLessThan(160);
    expect(mid).toBeGreaterThan(100);
    // A late echo of the drag does not pull it away.
    view.rerender(<Lagging value={160} />);
    now += 400;
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(row).toHaveValue("100");
    vi.restoreAllMocks();
  });

  it("holds nothing in the dock, whose one row serves every selected object", () => {
    function Dock({ value }: { value: number }) {
      return (
        <RangeRow variant="dock" label="Height" valueLabel={(v) => `${v}`} min={0} max={100} step={1} value={value} onChange={() => {}} testId="row" />
      );
    }
    const view = render(<Dock value={20} />);
    const row = screen.getByTestId("row");
    fireEvent.pointerDown(row);
    fireEvent.change(row, { target: { value: "70" } });
    fireEvent.pointerUp(row);
    // Another object is selected: its value shows at once.
    view.rerender(<Dock value={45} />);
    expect(row).toHaveValue("45");
  });

  it("lets go of the user's value when the row becomes another setting", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    function Swapped({ label, value }: { label: string; value: number }) {
      return (
        <RangeRow variant="stage" label={label} valueLabel={(v) => `${Math.round(v)}%`} min={0} max={100} step={1} value={value} onChange={() => {}} testId="row" />
      );
    }
    const view = render(<Swapped label="Width" value={50} />);
    const row = screen.getByTestId("row");
    fireEvent.change(row, { target: { value: "90" } });
    view.rerender(<Swapped label="Scale" value={30} />);
    // It glides to the new setting's value now, not once a hold on the old one runs out.
    now += 300;
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(row).toHaveValue("30");
    vi.restoreAllMocks();
  });
});
