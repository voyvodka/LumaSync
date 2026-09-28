import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "../ConfirmDialog";

function Harness({
  onConfirm = () => {},
  onCancel = () => {},
  enterCancels = false,
}: {
  onConfirm?: () => void;
  onCancel?: () => void;
  enterCancels?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <ConfirmDialog
          title="Discard changes?"
          body="Your edits are lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          tone="danger"
          enterCancels={enterCancels}
          onConfirm={() => {
            onConfirm();
            setOpen(false);
          }}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
        >
          <label>
            <input type="checkbox" /> Don't ask again
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

async function openDialog() {
  await userEvent.click(screen.getByText("open"));
  return screen.getByRole("dialog", { name: "Discard changes?" });
}

describe("ConfirmDialog", () => {
  it("is a named, described modal that takes focus", async () => {
    render(<Harness />);
    const dialog = await openDialog();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Your edits are lost.");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("keeps Tab inside the dialog", async () => {
    render(<Harness />);
    await openDialog();
    const checkbox = screen.getByRole("checkbox");
    const confirm = screen.getByRole("button", { name: "Discard" });
    confirm.focus();
    await userEvent.tab();
    expect(checkbox).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("cancels on Escape and hands focus back to the opener", async () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    await openDialog();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("open")).toHaveFocus();
  });

  it("cancels on a backdrop click but not on a click inside the card", async () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    const dialog = await openDialog();
    await userEvent.click(screen.getByText("Your edits are lost."));
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(dialog);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("with enterCancels, Enter anywhere but on Confirm is a no", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<Harness onCancel={onCancel} onConfirm={onConfirm} enterCancels />);
    await openDialog();
    screen.getByRole("checkbox").focus();
    await userEvent.keyboard("{Enter}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await openDialog();
    screen.getByRole("button", { name: "Discard" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
