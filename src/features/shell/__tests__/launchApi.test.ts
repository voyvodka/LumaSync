import { afterEach, describe, expect, it, vi } from "vitest";

import { SHELL_COMMANDS } from "@/shared/contracts/shell";
import { readStartHidden, type LaunchInvoker } from "../launchApi";

function invokerReturning(value: unknown): LaunchInvoker {
  return (<T,>(command: string) => {
    expect(command).toBe(SHELL_COMMANDS.GET_LAUNCH_CONTEXT);
    return Promise.resolve(value as T);
  }) as LaunchInvoker;
}

describe("readStartHidden", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows the backend's answer", async () => {
    await expect(readStartHidden(invokerReturning({ startHidden: true }))).resolves.toBe(true);
    await expect(readStartHidden(invokerReturning({ startHidden: false }))).resolves.toBe(false);
  });

  it("shows the window when the answer is missing", async () => {
    await expect(readStartHidden(invokerReturning(undefined))).resolves.toBe(false);
  });

  it("shows the window, and says why, when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: LaunchInvoker = () => Promise.reject(new Error("no such command"));

    await expect(readStartHidden(failing)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] [startup]"),
      expect.any(Error),
    );
  });
});
