import { describe, expect, it, vi } from "vitest";

import { PREVIEW_COMMANDS } from "@/shared/contracts/preview";

describe("PREVIEW_COMMANDS — Rust snake_case name regression", () => {
  it.each([
    ["START_TEST_PATTERN", "start_led_test_pattern"],
    ["STOP_TEST_PATTERN", "stop_led_test_pattern"],
    ["OPEN_PREVIEW", "open_preview"],
    ["CLOSE_PREVIEW", "close_preview"],
    ["SET_POPUP_HIDDEN", "set_preview_popup_hidden"],
    ["GET_SESSION", "get_preview_session"],
    ["SET_TWIN_HIDDEN", "set_preview_twin_hidden"],
    ["SUBSCRIBE_TWIN_FRAMES", "subscribe_twin_frames"],
    ["START_SCENE", "start_preview_scene"],
    ["STOP_SCENE", "stop_preview_scene"],
    ["SET_SCENE_BRIGHTNESS", "set_preview_scene_brightness"],
  ] as const)("%s maps to %s", (key, name) => {
    expect(PREVIEW_COMMANDS[key]).toBe(name);
  });
});

describe("preview session bridge", () => {
  it("answers null when the session read is rejected, never a made-up closed session", async () => {
    const { getPreviewSession } = await import("../previewApi");
    const rejecting = (() => Promise.reject(new Error("PREVIEW_SESSION_LOCK_FAILED: poisoned"))) as never;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getPreviewSession(rejecting)).resolves.toBeNull();
    errors.mockRestore();
  });

  it("sends the twin switch as a payload", async () => {
    const { setPreviewTwinHidden } = await import("../previewApi");
    const calls: unknown[][] = [];
    const invoker = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ session: { state: "closed" }, status: { code: "PREVIEW_NOT_OPEN", message: "", details: null } });
    }) as never;
    await setPreviewTwinHidden(true, invoker);
    expect(calls).toEqual([["set_preview_twin_hidden", { payload: { hidden: true } }]]);
  });

  it("sends a scene as a payload", async () => {
    const { startPreviewScene } = await import("../previewApi");
    const calls: unknown[][] = [];
    const invoker = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ session: { state: "closed" }, status: { code: "PREVIEW_NOT_OPEN", message: "", details: null } });
    }) as never;
    await startPreviewScene("letterbox", invoker);
    expect(calls).toEqual([["start_preview_scene", { payload: { kind: "letterbox" } }]]);
  });

  // A rejected stop says nothing about the lights: never claim the scene stopped.
  it("answers a rejected scene stop as a failed restore", async () => {
    const { stopPreviewScene } = await import("../previewApi");
    const rejecting = (() => Promise.reject(new Error("LIGHTING_TRANSITION_WORKER_FAILED: gone"))) as never;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await stopPreviewScene(rejecting);
    expect(result.status.code).toBe("PREVIEW_RESTORE_FAILED");
    errors.mockRestore();
  });
});
