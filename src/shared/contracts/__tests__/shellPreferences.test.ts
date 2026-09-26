import { describe, expect, it } from "vitest";

import { resolveCloseAction, resolveLaunchLights, resolveNotificationsPreference, resolveUiZoom } from "../shell";

// The same inputs as `settings_preferences_default_unless_set_to_a_known_value` in
// `commands/shell_state.rs`: both sides must read a stored value the same way.
describe("settings preferences Rust also reads", () => {
  it("reads the interface size only as a listed whole percent", () => {
    expect(resolveUiZoom(undefined)).toBe(100);
    expect(resolveUiZoom(125)).toBe(125);
    expect(resolveUiZoom(90)).toBe(90);
    expect(resolveUiZoom(150)).toBe(100);
    expect(resolveUiZoom(1.1)).toBe(100);
    expect(resolveUiZoom("110")).toBe(100);
  });

  it("defaults everything else unless set to a known value", () => {
    expect(resolveCloseAction(undefined)).toBe("tray");
    expect(resolveCloseAction("quit")).toBe("quit");
    expect(resolveCloseAction("exit")).toBe("tray");
    expect(resolveNotificationsPreference(undefined)).toBe("on");
    expect(resolveNotificationsPreference("off")).toBe("off");
    expect(resolveNotificationsPreference(false)).toBe("on");
    expect(resolveLaunchLights(undefined)).toBe("resume");
    expect(resolveLaunchLights("off")).toBe("off");
  });
});
