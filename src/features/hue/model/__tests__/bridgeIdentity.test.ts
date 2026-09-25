import { describe, expect, it } from "vitest";

import { dedupeBridges, normalizeIpValue, relocatedBridge, resolveManualIpError } from "../bridgeIdentity";

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

  // Every caller lists the fresh answer first; last-wins kept the old address.
  it("keeps one entry per id, the first listed winning", () => {
    const result = dedupeBridges([bridge("a", "10.0.0.2"), bridge("a", "10.0.0.1")]);

    expect(result).toHaveLength(1);
    expect(result[0]?.ip).toBe("10.0.0.2");
  });

  it("preserves first-seen order across distinct ids", () => {
    const result = dedupeBridges([bridge("a", "10.0.0.1"), bridge("b", "10.0.0.2"), bridge("a", "10.0.0.3")]);

    expect(result.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result[0]?.ip).toBe("10.0.0.1");
  });

  it("treats the cloud's lower-case id and /api/config's upper-case id as one bridge", () => {
    const result = dedupeBridges([bridge("001788FFFE7E57B1", "10.0.0.9"), bridge("001788fffe7e57b1", "10.0.0.1")]);

    expect(result).toHaveLength(1);
    expect(result[0]?.ip).toBe("10.0.0.9");
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeBridges([])).toEqual([]);
  });
});

describe("relocatedBridge", () => {
  const saved = { id: "001788fffe7e57b1", ip: "10.0.0.1", name: "Living room" };

  it("moves the bridge to its new address and keeps its id and name", () => {
    expect(relocatedBridge(saved, [{ id: "001788FFFE7E57B1", ip: "10.0.0.7", name: "Hue Bridge (10.0.0.7)" }])).toEqual({
      ...saved,
      ip: "10.0.0.7",
    });
  });

  it("is null when the bridge is where it was, or not in the answer", () => {
    expect(relocatedBridge(saved, [{ ...saved }])).toBeNull();
    expect(relocatedBridge(saved, [{ id: "other", ip: "10.0.0.7", name: "Other" }])).toBeNull();
  });
});
