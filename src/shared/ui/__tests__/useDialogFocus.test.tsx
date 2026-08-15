import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useDialogFocus } from "../useDialogFocus";

function Dialog({ open, onClose }: { open: boolean; onClose?: () => void }) {
  const { containerRef, handleKeyDown } = useDialogFocus(open, { onClose });
  if (!open) return null;
  return (
    <div ref={containerRef} onKeyDown={handleKeyDown} tabIndex={-1} role="dialog" aria-modal="true">
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

function Harness({ open, onClose }: { open: boolean; onClose?: () => void }) {
  return (
    <>
      <button type="button">opener</button>
      <Dialog open={open} onClose={onClose} />
    </>
  );
}

describe("useDialogFocus", () => {
  it("moves focus into the dialog when it opens", () => {
    const { rerender } = render(<Harness open={false} />);
    screen.getByText("opener").focus();

    rerender(<Harness open />);

    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("returns focus to whatever opened it", () => {
    const { rerender } = render(<Harness open={false} />);
    const opener = screen.getByText("opener");
    opener.focus();

    rerender(<Harness open />);
    rerender(<Harness open={false} />);

    expect(document.activeElement).toBe(opener);
  });

  it("wraps Tab from the last control back to the first", async () => {
    const user = userEvent.setup();
    render(<Harness open />);
    screen.getByText("second").focus();

    await user.tab();

    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Shift+Tab from the first control to the last", async () => {
    const user = userEvent.setup();
    render(<Harness open />);
    screen.getByText("first").focus();

    await user.tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByText("second"));
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape for a dialog that must be answered", async () => {
    const user = userEvent.setup();
    render(<Harness open />);

    await user.keyboard("{Escape}");

    expect(document.activeElement).toBe(screen.getByText("first"));
  });
});
