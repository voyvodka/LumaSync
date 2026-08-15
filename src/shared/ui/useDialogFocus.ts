// `aria-modal="true"` without a focus trap is worse than neither: it tells
// assistive technology the background is inert while focus still tabs into it.

import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export interface UseDialogFocusOptions {
  /** Escape, and the backdrop click if the caller wires one. Omit for a dialog
   *  that must be answered — Escape then does nothing rather than guessing. */
  onClose?: () => void;
}

/**
 * Attach the returned ref to the dialog's outermost element. Focus moves in
 * while `open`, cycles inside it, and returns on close.
 */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  { onClose }: UseDialogFocusOptions = {},
) {
  const containerRef = useRef<T | null>(null);
  const restoreToRef = useRef<HTMLElement | null>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    restoreToRef.current = document.activeElement as HTMLElement | null;

    if (container) {
      const first = focusableWithin(container)[0];
      // The container itself is the fallback so focus never stays on the
      // element behind an `aria-modal` dialog.
      (first ?? container).focus();
    }

    return () => {
      const restoreTo = restoreToRef.current;
      restoreToRef.current = null;
      if (restoreTo?.isConnected) restoreTo.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<T>) => {
    if (event.key === "Escape") {
      const close = onCloseRef.current;
      if (!close) return;
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const container = containerRef.current;
    if (!container) return;
    const focusable = focusableWithin(container);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === container)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return { containerRef, handleKeyDown };
}
