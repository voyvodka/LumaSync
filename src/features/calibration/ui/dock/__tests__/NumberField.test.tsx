import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NumberField } from "../NumberField";

function setup(value = 80) {
  const onCommit = vi.fn<(n: number) => void>();
  const onPreview = vi.fn<(n: number | null) => void>();
  render(
    <NumberField
      value={value}
      min={4}
      max={500}
      unit="LED"
      labels={{ edit: "edit", field: "field", apply: "apply", range: "4–500" }}
      describe={(n) => `${n} described`}
      suggestion={{ value: 150, label: "WLED: 150" }}
      onCommit={onCommit}
      onPreview={onPreview}
    />,
  );
  return { onCommit, onPreview, field: () => screen.getByRole("textbox", { name: "field" }) };
}

describe("NumberField", () => {
  it("commits a changed number on leaving, previewing it while typing", async () => {
    const user = userEvent.setup();
    const { onCommit, onPreview, field } = setup();
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.clear(field());
    await user.type(field(), "120");
    expect(onPreview).toHaveBeenLastCalledWith(120);
    fireEvent.blur(field());
    expect(onCommit).toHaveBeenCalledWith(120);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("does not commit the same number, and Esc puts the value back", async () => {
    const user = userEvent.setup();
    const { onCommit, field } = setup();
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.clear(field());
    await user.type(field(), "200{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "edit" })).toBeInTheDocument();
  });

  it("steps with the arrows, clamped to the range, and rejects an out-of-range number", async () => {
    const user = userEvent.setup();
    const { onCommit, field } = setup(499);
    screen.getByRole("button", { name: "edit" }).focus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(field()).toHaveValue("500");
    await user.clear(field());
    await user.type(field(), "2");
    expect(screen.getByText("4–500")).toBeInTheDocument();
    fireEvent.blur(field());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("offers the suggestion while editing and takes it on a press", async () => {
    const user = userEvent.setup();
    const { onCommit, field } = setup();
    await user.click(screen.getByRole("button", { name: "edit" }));
    await user.click(screen.getByRole("button", { name: "WLED: 150" }));
    expect(field()).toHaveValue("150");
    await user.click(screen.getByRole("button", { name: "apply" }));
    expect(onCommit).toHaveBeenCalledWith(150);
  });
});
