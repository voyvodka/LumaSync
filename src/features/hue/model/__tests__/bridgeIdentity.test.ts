import { describe, expect, it } from "vitest";

import { dedupeBridges, normalizeIpValue, resolveManualIpError } from "../bridgeIdentity";

describe("normalizeIpValue", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeIpValue("  192.168.1.20\t")).toBe("192.168.1.20");
  });
});

describe("resolveManualIpError", () => {
  it("treats an empty value as not-yet-an-error", () => {
    expect(resolveManualIpError("")).toBeNull();
    expect(resolveManualIpError("   ")).toBeNull();
  });

  it.each(["192.168.1.20", "10.0.0.1", "255.255.255.255", "0.0.0.0", "127.0.0.1"])(
    "accepts the well-formed address %s",
    (value) => {
      expect(resolveManualIpError(value)).toBeNull();
    },
  );

  it.each(["192.168.1", "192.168.1.256", "1.2.3.4.5", "bridge.local", "192.168.1.-1", "::1"])(
    "rejects the malformed address %s",
    (value) => {
      expect(resolveManualIpError(value)).toBe("hue:manualIp.invalid");
    },
  );

  it("validates the trimmed value, not the raw one", () => {
    expect(resolveManualIpError(" 192.168.1.20 ")).toBeNull();
  });
});

describe("dedupeBridges", () => {
  const bridge = (id: string, ip: string) => ({ id, ip, name: `Bridge ${id}` });

  it("keeps one entry per id, last write winning", () => {
    const result = dedupeBridges([bridge("a", "10.0.0.1"), bridge("a", "10.0.0.2")]);

    expect(result).toHaveLength(1);
    expect(result[0]?.ip).toBe("10.0.0.2");
  });

  it("preserves first-seen order across distinct ids", () => {
    const result = dedupeBridges([bridge("a", "10.0.0.1"), bridge("b", "10.0.0.2"), bridge("a", "10.0.0.3")]);

    expect(result.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result[0]?.ip).toBe("10.0.0.3");
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeBridges([])).toEqual([]);
  });
});
