import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchContext } from "@/shared/contracts/shell";
import { mockCommands } from "@/test/mockCommands";
import { readE2eBuild, readStartHidden } from "../launchApi";

// `undefined` is off the contract on purpose: it is what an older or mocked
// backend answers, and the read must survive it.
function invokerReturning(value: LaunchContext | undefined) {
  return mockCommands({ get_launch_context: value as LaunchContext });
}

const failing = mockCommands({
  get_launch_context: () => Promise.reject(new Error("no such command")),
});

describe("readStartHidden", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows the backend's answer", async () => {
    await expect(readStartHidden(invokerReturning({ startHidden: true, e2eBuild: false }))).resolves.toBe(true);
    await expect(readStartHidden(invokerReturning({ startHidden: false, e2eBuild: false }))).resolves.toBe(false);
  });

  it("shows the window when the answer is missing", async () => {
    await expect(readStartHidden(invokerReturning(undefined))).resolves.toBe(false);
  });

  it("shows the window, and says why, when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(readStartHidden(failing)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] [startup]"),
      expect.any(Error),
    );
  });
});

describe("readE2eBuild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows the backend's answer", async () => {
    await expect(readE2eBuild(invokerReturning({ startHidden: false, e2eBuild: true }))).resolves.toBe(true);
    await expect(readE2eBuild(invokerReturning({ startHidden: false, e2eBuild: false }))).resolves.toBe(false);
  });

  it("assumes a normal build when the answer is missing", async () => {
    await expect(readE2eBuild(invokerReturning(undefined))).resolves.toBe(false);
  });

  it("assumes a normal build, and says why, when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(readE2eBuild(failing)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[LumaSync] [startup]"), expect.any(Error));
  });
});
