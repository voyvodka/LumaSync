import { describe, expect, it } from "vitest";

import { shouldPersistLastSuccessfulPort } from "./portSelection";

describe("selection memory", () => {
  it("persist only on successful connect", () => {
    expect(shouldPersistLastSuccessfulPort("COM3", true)).toBe(true);
    expect(shouldPersistLastSuccessfulPort("COM3", false)).toBe(false);
    expect(shouldPersistLastSuccessfulPort(null, true)).toBe(false);
  });
});
