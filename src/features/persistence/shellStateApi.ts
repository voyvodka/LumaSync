/** `invoke()` bridge for the shell-state commands. Rust owns `shell-state.json`;
 * see docs/architecture/contracts-and-state.md, "Shell-state ownership". */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  SHELL_COMMANDS,
  SHELL_STATE_CHANGED_EVENT,
  type ShellState,
  type ShellStateChanged,
  type ShellStatePatchRequest,
  type ShellStateReplaceRequest,
  type ShellStateSnapshot,
  type ShellStateWriteResult,
} from "@/shared/contracts/shell";

export function getShellState(): Promise<ShellStateSnapshot> {
  return invoke<ShellStateSnapshot>(SHELL_COMMANDS.GET_SHELL_STATE);
}

export function patchShellState(patch: ShellStatePatchRequest): Promise<ShellStateWriteResult> {
  return invoke<ShellStateWriteResult>(SHELL_COMMANDS.PATCH_SHELL_STATE, { patch });
}

export function replaceShellState(request: ShellStateReplaceRequest): Promise<ShellStateWriteResult> {
  return invoke<ShellStateWriteResult>(SHELL_COMMANDS.REPLACE_SHELL_STATE, { request });
}

export function onShellStateChanged(
  handler: (changed: ShellStateChanged) => void,
): Promise<UnlistenFn> {
  return listen<ShellStateChanged>(SHELL_STATE_CHANGED_EVENT, (event) => handler(event.payload));
}

/** A partial as a patch: an `undefined` value is a key to delete, and must be
 * sent as one — `invoke` serialises through JSON, which drops it. */
export function toShellStatePatch(
  partial: Partial<ShellState>,
  writerId: string,
): ShellStatePatchRequest {
  const set: Record<string, unknown> = {};
  const remove: (keyof ShellState)[] = [];
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) remove.push(key as keyof ShellState);
    else set[key] = value;
  }
  return { set: set as Partial<ShellState>, remove, writerId };
}
