import { describe, expect, it } from "vitest";

import { wledAddressError } from "../wledStatus";

describe("wledAddressError", () => {
  it("takes a dotted IPv4, trimmed", () => {
    expect(wledAddressError(" 192.168.1.42 ")).toBeNull();
  });

  it("asks for an address when there is none", () => {
    expect(wledAddressError("  ")).toBe("device:page.wled.ipRequired");
  });

  // Rust parses IPv4 only: anything else passed here would come back as a failure from the device call.
  it.each(["fe80::1", "cafe", "wled.local", "192.168.1"])("refuses %s before asking the device", (value) => {
    expect(wledAddressError(value)).toBe("device:page.wled.invalidIp");
  });
});
