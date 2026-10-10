import { describe, expect, it } from "vitest";

import { PREVIEW_COMMANDS } from "@/shared/contracts/preview";

describe("PREVIEW_COMMANDS — Rust snake_case name regression", () => {
  it.each([
    ["START_TEST_PATTERN", "start_led_test_pattern"],
    ["STOP_TEST_PATTERN", "stop_led_test_pattern"],
    ["OPEN_PREVIEW", "open_preview"],
    ["CLOSE_PREVIEW", "close_preview"],
    ["SET_POPUP_HIDDEN", "set_preview_popup_hidden"],
    ["SUBSCRIBE_TWIN_FRAMES", "subscribe_twin_frames"],
  ] as const)("%s maps to %s", (key, name) => {
    expect(PREVIEW_COMMANDS[key]).toBe(name);
  });
});
