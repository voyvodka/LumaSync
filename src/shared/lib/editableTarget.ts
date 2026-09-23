/** True when a key event belongs to a form control or editable region, so an
 *  app shortcut must stand aside and let the native behaviour run — typing,
 *  Backspace, arrow keys on a slider, and the field's own Cmd/Ctrl+Z undo. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
