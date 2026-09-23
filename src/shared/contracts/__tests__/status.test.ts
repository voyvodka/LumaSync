import { describe, expect, it } from "vitest";

import { parseCommandError } from "../status";

describe("parseCommandError", () => {
  it("splits a Rust `\"CODE: context\"` rejection", () => {
    expect(parseCommandError("LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock")).toEqual({
      code: "LIGHTING_RUNTIME_STATE_LOCK_FAILED",
      message: "LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock",
      details: "poisoned lock",
    });
  });

  it("reads a bare code as a code with no details", () => {
    expect(parseCommandError(" AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND ")).toEqual({
      code: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
      message: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
      details: null,
    });
  });

  it("keeps uncoded text whole, colon and all", () => {
    expect(parseCommandError("Could not open port: busy")).toEqual({
      code: null,
      message: "Could not open port: busy",
      details: null,
    });
  });

  it("reads an Error by its message, so the name prefix never leaks in", () => {
    expect(parseCommandError(new Error("HUE_STOP_TIMEOUT: sender held"))).toMatchObject({
      code: "HUE_STOP_TIMEOUT",
      message: "HUE_STOP_TIMEOUT: sender held",
    });
  });

  it("prefers a structured rejection's own fields", () => {
    expect(
      parseCommandError({ code: "PORT_NOT_FOUND", message: "No such port", details: "COM9" }),
    ).toEqual({ code: "PORT_NOT_FOUND", message: "No such port", details: "COM9" });
  });

  it("never serialises an object without a message, which could hold credentials", () => {
    const parsed = parseCommandError({ clientKey: "secret", username: "hue-user" });
    expect(parsed.code).toBeNull();
    expect(parsed.message).not.toContain("secret");
    expect(parsed.message).not.toContain("[object Object]");
  });

  it("gives null and undefined a readable message rather than 'undefined'", () => {
    expect(parseCommandError(undefined).message).not.toBe("undefined");
    expect(parseCommandError(null).message).not.toBe("null");
  });
});
