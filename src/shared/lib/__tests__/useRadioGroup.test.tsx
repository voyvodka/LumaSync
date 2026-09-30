import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useRadioGroup } from "../useRadioGroup";

type Option = "a" | "b" | "c" | "d";

function Group({
  initial,
  disabled = [],
  onChange,
}: {
  initial: Option | null;
  disabled?: Option[];
  onChange?: (value: Option) => void;
}) {
  const [value, setValue] = useState<Option | null>(initial);
  const { itemProps } = useRadioGroup<Option>({
    values: ["a", "b", "c", "d"],
    value,
    onChange: (next) => {
      setValue(next);
      onChange?.(next);
    },
    isDisabled: (option) => disabled.includes(option),
  });
  return (
    <div role="radiogroup" aria-label="letters">
      {(["a", "b", "c", "d"] as const).map((option) => (
        <button key={option} type="button" {...itemProps(option)} disabled={disabled.includes(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });
const tabStops = () => screen.getAllByRole("radio").filter((el) => el.tabIndex === 0);

describe("useRadioGroup", () => {
  it("is one tab stop, on the checked option", () => {
    render(<Group initial="c" />);
    expect(tabStops()).toEqual([radio("c")]);
    expect(radio("c")).toHaveAttribute("aria-checked", "true");
    expect(radio("a")).toHaveAttribute("aria-checked", "false");
  });

  // Otherwise Tab would skip the group entirely.
  it("with nothing checked, or the checked one disabled, the first enabled option holds the tab stop", () => {
    const { unmount } = render(<Group initial={null} disabled={["a"]} />);
    expect(tabStops()).toEqual([radio("b")]);
    unmount();
    render(<Group initial="c" disabled={["a", "c"]} />);
    expect(tabStops()).toEqual([radio("b")]);
  });

  it("arrow keys move focus and check, wrapping, and skip disabled options", () => {
    const onChange = vi.fn<(value: Option) => void>();
    render(<Group initial="a" disabled={["b"]} onChange={onChange} />);
    fireEvent.keyDown(radio("a"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(radio("c")).toHaveFocus();
    expect(radio("c")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio("c"), { key: "ArrowDown" });
    fireEvent.keyDown(radio("d"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(radio("a"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("d");
  });

  it("Home and End jump to the ends; a modified key is left to the app", () => {
    const onChange = vi.fn<(value: Option) => void>();
    render(<Group initial="b" onChange={onChange} />);
    fireEvent.keyDown(radio("b"), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("d");
    fireEvent.keyDown(radio("d"), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    onChange.mockClear();
    fireEvent.keyDown(radio("a"), { key: "ArrowRight", metaKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a click checks the option", () => {
    const onChange = vi.fn<(value: Option) => void>();
    render(<Group initial="a" onChange={onChange} />);
    fireEvent.click(radio("d"));
    expect(onChange).toHaveBeenCalledWith("d");
    expect(radio("d")).toHaveAttribute("aria-checked", "true");
  });
});
