import { describe, expect, it } from "vitest";

import { hueUnavailableReason } from "../hueAvailability";

describe("hueUnavailableReason", () => {
  it("is null only for a paired, reachable bridge", () => {
    expect(hueUnavailableReason(true, true, "reachable")).toBeNull();
    // An active session counts as reachable even if a stale probe said otherwise.
    expect(hueUnavailableReason(true, true, "credentialRejected")).toBeNull();
  });

  it("says not configured whenever no bridge is paired", () => {
    expect(hueUnavailableReason(false, true, null)).toBe("notConfigured");
    expect(hueUnavailableReason(false, false, "credentialRejected")).toBe("notConfigured");
  });

  it("tells a rejected key from a silent bridge from a pending probe", () => {
    expect(hueUnavailableReason(true, false, "credentialRejected")).toBe("keyRejected");
    expect(hueUnavailableReason(true, false, "unreachable")).toBe("unreachable");
    expect(hueUnavailableReason(true, false, null)).toBe("checking");
  });
});
