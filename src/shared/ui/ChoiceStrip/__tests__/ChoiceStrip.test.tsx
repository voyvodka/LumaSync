import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChoiceStrip } from "../ChoiceStrip";

const options = [
  { value: "slow", label: "Slow" },
  { value: "fast", label: "Fast" },
];

describe("ChoiceStrip", () => {
  it("is a named radio group whose options carry their test ids and report a pick", () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<ChoiceStrip label="Speed" value="slow" options={options} onChange={onChange} testIdPrefix="speed-" />);
    expect(screen.getByRole("radiogroup", { name: "Speed" })).toBeInTheDocument();
    expect(screen.getByTestId("speed-slow")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("speed-fast"));
    expect(onChange).toHaveBeenCalledWith("fast");
  });

  it("with nothing chosen, checks nothing", () => {
    render(<ChoiceStrip label="Speed" value={null} options={options} onChange={() => {}} />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toHaveAttribute("aria-checked", "false");
  });
});
