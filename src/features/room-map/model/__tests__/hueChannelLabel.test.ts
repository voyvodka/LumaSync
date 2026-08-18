import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import { hueChannelDotText, hueChannelIdLabel, hueChannelName } from "../hueChannelLabel";

/** Echoes the key with its interpolation, so a test can see which key was used. */
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key} ${JSON.stringify(opts)}` : key) as unknown as TFunction;

describe("hueChannelIdLabel", () => {
  it("renders the bridge id raw, because #0 is a legitimate channel", () => {
    expect(hueChannelIdLabel(0)).toBe("#0");
    expect(hueChannelIdLabel(5)).toBe("#5");
  });

  it("says nothing when the placement was never matched to a bridge light", () => {
    expect(hueChannelIdLabel(null)).toBeNull();
    expect(hueChannelIdLabel(undefined)).toBeNull();
  });
});

describe("hueChannelDotText", () => {
  it("drops the hash for the canvas dot but keeps the id", () => {
    expect(hueChannelDotText(0)).toBe("0");
    expect(hueChannelDotText(12)).toBe("12");
  });

  it("marks an unmatched channel rather than inventing a number", () => {
    expect(hueChannelDotText(null)).toBe("?");
  });
});

describe("hueChannelName", () => {
  it("prefers the user's own name", () => {
    expect(hueChannelName({ label: "Sofa lamp", channelId: 5 }, t)).toBe("Sofa lamp");
  });

  it("falls back to the bridge id, never to the ordinal", () => {
    // channelIndex is not even passed in — the ordinal cannot leak into a name.
    expect(hueChannelName({ channelId: 5 }, t)).toBe(
      'roomMap:hueChannel.defaultLabel {"id":"#5"}',
    );
  });

  it("names channel #0 rather than treating a falsy id as absent", () => {
    expect(hueChannelName({ channelId: 0 }, t)).toBe(
      'roomMap:hueChannel.defaultLabel {"id":"#0"}',
    );
  });

  it("says unmatched when there is no bridge id at all", () => {
    expect(hueChannelName({ channelId: null }, t)).toBe("roomMap:hueChannel.unresolvedLabel");
  });

  it("treats an empty label as no label", () => {
    expect(hueChannelName({ label: "", channelId: 5 }, t)).toBe(
      'roomMap:hueChannel.defaultLabel {"id":"#5"}',
    );
  });
});
