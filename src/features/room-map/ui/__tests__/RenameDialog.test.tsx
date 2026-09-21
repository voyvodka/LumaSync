/**
 * What changed here is that the dialog stopped hand-rolling its own trap and
 * stopped covering the title bar. Focus restore is deliberately NOT re-tested:
 * `useDialogFocus` owns it and `shared/ui/__tests__/useDialogFocus.test.tsx`
 * already pins it. These cases assert that this dialog is wired to that hook
 * and that its backdrop leaves the drag region alone.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RenameDialog } from "../RenameDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderDialog() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <RenameDialog
      currentLabel="Sofa"
      promptText="Rename"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel, ...view };
}

describe("RenameDialog", () => {
  it("opens with focus on the name, ready to overwrite it", () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("does not cover the title bar, so the window stays draggable", () => {
    // `fixed inset-0` here reintroduced the exact bug the updater modal was
    // fixed for: a full-viewport backdrop sits over the drag region and the
    // window controls, and nothing forwards the drag to the OS.
    expect(renderDialog().getByRole("dialog").getAttribute("style")).toContain(
      "top: var(--lm-titlebar-h)",
    );
  });

  it("cancels on Escape raised from inside the dialog", () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("input, button"));
    expect(focusable.length).toBeGreaterThan(1);

    // Wrapping from the last control is the case that matters: without it,
    // Tab escapes to the page behind an element claiming `aria-modal`.
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
  });
});
