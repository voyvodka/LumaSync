import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Segmented } from "../Segmented";

type Speed = "slow" | "med" | "fast" | "max";

function Harness({
  initial,
  disabled = [],
  onChange = () => {},
}: {
  initial: Speed | null;
  disabled?: Speed[];
  onChange?: (value: Speed) => void;
}) {
  const [value, setValue] = useState<Speed | null>(initial);
  return (
    <>
      <button type="button">before</button>
      <Segmented
        ariaLabel="Speed"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={(["slow", "med", "fast", "max"] as const).map((speed) => ({
          value: speed,
          label: speed,
          disabled: disabled.includes(speed),
        }))}
      />
    </>
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("Segmented", () => {
  it("is one radio group with a single tab stop on the checked option", async () => {
    render(<Harness initial="fast" />);
    expect(screen.getByRole("radiogroup", { name: "Speed" })).toBeInTheDocument();
    expect(radio("fast")).toHaveAttribute("aria-checked", "true");
    expect(radio("fast")).toHaveAttribute("tabindex", "0");
    expect(radio("slow")).toHaveAttribute("tabindex", "-1");

    screen.getByText("before").focus();
    await userEvent.tab();
    expect(radio("fast")).toHaveFocus();
  });

  it("parks the tab stop on the first enabled option when nothing is checked", () => {
    render(<Harness initial={null} disabled={["slow"]} />);
    expect(radio("med")).toHaveAttribute("tabindex", "0");
    for (const name of ["slow", "fast", "max"]) {
      expect(radio(name)).toHaveAttribute("tabindex", "-1");
      expect(radio(name)).toHaveAttribute("aria-checked", "false");
    }
  });

  it("moves focus and selection with the arrow keys, wrapping at both ends", async () => {
    const onChange = vi.fn();
    render(<Harness initial="slow" onChange={onChange} />);
    radio("slow").focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(radio("med")).toHaveFocus();
    expect(radio("med")).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{ArrowDown}");
    expect(radio("fast")).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}{ArrowUp}{ArrowUp}");
    expect(radio("max")).toHaveFocus();
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(["med", "fast", "med", "slow", "max"]);
  });

  it("skips disabled options", async () => {
    render(<Harness initial="slow" disabled={["med", "fast"]} />);
    radio("slow").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radio("max")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radio("slow")).toHaveFocus();
  });

  it("jumps to the ends with Home and End", async () => {
    render(<Harness initial="med" />);
    radio("med").focus();
    await userEvent.keyboard("{End}");
    expect(radio("max")).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Home}");
    expect(radio("slow")).toHaveAttribute("aria-checked", "true");
  });

  it("leaves modified arrows alone — Alt+digit and friends belong to the global keybinds", async () => {
    const onChange = vi.fn();
    render(<Harness initial="slow" onChange={onChange} />);
    radio("slow").focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onChange).not.toHaveBeenCalled();
    expect(radio("slow")).toHaveFocus();
  });

  it("disables every option when the group is disabled", () => {
    render(
      <Segmented
        ariaLabel="Speed"
        value="slow"
        onChange={() => {}}
        disabled
        options={[
          { value: "slow", label: "slow" },
          { value: "fast", label: "fast" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-disabled", "true");
    expect(radio("slow")).toBeDisabled();
    expect(radio("fast")).toBeDisabled();
  });
});
