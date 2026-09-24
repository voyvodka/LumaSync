// The latch behind the shell's "settings can't be saved" notice, driven the
// way the dev mock's `persist-failing` scenario drives it: Rust refusing every
// write with SHELL_STATE_WRITE_FAILED.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHELL_COMMANDS, SHELL_STATE_SCHEMA_VERSION } from "@/shared/contracts/shell";
import { createFakeShellStateBackend } from "@/test/fakeShellStateBackend";

import {
  __resetShellStateWriteHealthForTests,
  isShellStateWriteFailing,
} from "../writeHealth";
import { shellStore } from "../shellStore";

let backend = createFakeShellStateBackend();
let writesFail = false;

const WRITE_COMMANDS: readonly string[] = [SHELL_COMMANDS.PATCH_SHELL_STATE, SHELL_COMMANDS.REPLACE_SHELL_STATE];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    if (writesFail && WRITE_COMMANDS.includes(command)) {
      return Promise.reject(new Error("SHELL_STATE_WRITE_FAILED: shell-state write refused"));
    }
    return backend.invoke(command, args) ?? Promise.reject(new Error(`unexpected invoke: ${command}`));
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { event: string; payload: unknown }) => void) =>
    backend.listen(event, handler),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn<() => unknown>() }));

describe("shell-state write health", () => {
  beforeEach(() => {
    backend = createFakeShellStateBackend({ schemaVersion: SHELL_STATE_SCHEMA_VERSION });
    writesFail = false;
    __resetShellStateWriteHealthForTests();
  });
  afterEach(() => {
    __resetShellStateWriteHealthForTests();
  });

  it("latches when a save is refused, and the caller still sees the rejection", async () => {
    writesFail = true;

    await expect(shellStore.save({ language: "tr" })).rejects.toThrow("SHELL_STATE_WRITE_FAILED");
    expect(isShellStateWriteFailing()).toBe(true);
  });

  it("clears on the next write that lands", async () => {
    writesFail = true;
    await expect(shellStore.save({ showNerdStats: true })).rejects.toThrow();
    expect(isShellStateWriteFailing()).toBe(true);

    writesFail = false;
    await shellStore.save({ showNerdStats: true });
    expect(isShellStateWriteFailing()).toBe(false);
  });

  it("latches on a refused read-modify-write too", async () => {
    writesFail = true;

    await expect(shellStore.update(() => ({ roomMapShowGrid: true }))).rejects.toThrow();
    expect(isShellStateWriteFailing()).toBe(true);
  });

  it("stays clear while writes land", async () => {
    await shellStore.save({ lastSection: "system" });
    await shellStore.update(() => ({ roomMapShowGrid: false }));
    expect(isShellStateWriteFailing()).toBe(false);
  });
});
