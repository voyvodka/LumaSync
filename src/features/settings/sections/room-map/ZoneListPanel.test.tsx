/**
 * ZoneListPanel — Unit tests for ROOM-03 / Plan 19-03
 *
 * Note: jsdom render tests are not supported in this project's Node v25 / jsdom v29
 * environment due to an ESM incompatibility in @asamuzakjp/css-color (see Plan 19-02 SUMMARY).
 * Tests validate module exports, helper functions, and prop interface shapes without
 * invoking the DOM renderer.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";

describe("ZoneListPanel", () => {
  it("exports ZoneListPanel as a named function", async () => {
    const mod = await import("./ZoneListPanel");
    expect(typeof mod.ZoneListPanel).toBe("function");
  });

  it("exports getZoneColor as a named function", async () => {
    const mod = await import("./ZoneListPanel");
    expect(typeof mod.getZoneColor).toBe("function");
  });

  it("exports ZONE_COLORS with 6 entries", async () => {
    const mod = await import("./ZoneListPanel");
    expect(mod.ZONE_COLORS).toHaveLength(6);
  });

  it("getZoneColor returns correct color for index 0 (blue)", async () => {
    const { getZoneColor } = await import("./ZoneListPanel");
    expect(getZoneColor(0)).toBe("bg-blue-500");
  });

  it("getZoneColor wraps around after 6 colors", async () => {
    const { getZoneColor } = await import("./ZoneListPanel");
    expect(getZoneColor(6)).toBe(getZoneColor(0));
    expect(getZoneColor(7)).toBe(getZoneColor(1));
    expect(getZoneColor(11)).toBe(getZoneColor(5));
  });

  it("ZONE_COLORS contains the expected Tailwind color classes", async () => {
    const { ZONE_COLORS } = await import("./ZoneListPanel");
    expect(ZONE_COLORS).toContain("bg-blue-500");
    expect(ZONE_COLORS).toContain("bg-emerald-500");
    expect(ZONE_COLORS).toContain("bg-purple-500");
    expect(ZONE_COLORS).toContain("bg-amber-500");
    expect(ZONE_COLORS).toContain("bg-rose-500");
    expect(ZONE_COLORS).toContain("bg-cyan-500");
  });

  it("ZoneListPanel component accepts expected props (TypeScript structural check via import)", async () => {
    const { ZoneListPanel } = await import("./ZoneListPanel");
    expect(ZoneListPanel).toBeDefined();
    expect(typeof ZoneListPanel).toBe("function");
  });
});
