import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmPopover } from "../ConfirmPopover";

function setup({ danger = false, title }: { danger?: boolean; title?: string } = {}) {
  const anchor = createRef<HTMLButtonElement>();
  const onConfirm = vi.fn<() => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <>
      <button ref={anchor} type="button">
        Forget
      </button>
      <ConfirmPopover
        open
        anchorRef={anchor}
        label="Forget the strip?"
        title={title}
        text="Its layout goes too."
        confirmLabel="Forget"
        cancelLabel="Cancel"
        danger={danger}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirmTestId="confirm"
      />
    </>,
  );
  return { anchor, onConfirm, onCancel };
}

describe("ConfirmPopover", () => {
  it("asks as a named dialog and starts on the confirm", () => {
    setup({ title: "Forget it?" });
    const dialog = screen.getByRole("dialog", { name: "Forget the strip?" });
    expect(dialog).toHaveTextContent("Forget it?");
    expect(dialog).toHaveTextContent("Its layout goes too.");
    expect(screen.getByTestId("confirm")).toHaveFocus();
  });

  // A stray Enter must keep what a dangerous confirm would let go.
  it("a dangerous question starts on Cancel", () => {
    setup({ danger: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("an answer hands focus back to what asked", () => {
    const { anchor, onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByTestId("confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(anchor.current).toHaveFocus();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(anchor.current).toHaveFocus();
  });

  it("Esc answers no", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
