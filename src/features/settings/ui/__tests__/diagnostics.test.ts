import { describe, expect, it } from "vitest";

import { buildDiagnostics, type DiagnosticsInput } from "../diagnostics";

const BASE: DiagnosticsInput = {
  appName: "LumaSync",
  appVersion: "1.5.5",
  os: "macOS",
  channel: "stable",
  mode: "ambilight",
  outputs: ["usb", "hue"],
  localSink: { transport: "serial", id: "/dev/cu.usbserial-1420", product: "CH340" },
  calibration: {
    counts: { top: 60, right: 22, bottom: 60, left: 22 },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
    totalLeds: 164,
  },
  hue: { configured: true, reachable: true, streaming: true, reconnecting: false },
  uiZoom: 110,
  motion: "system",
  language: "tr",
};

describe("buildDiagnostics", () => {
  it("says what a bug report needs, one line each", () => {
    expect(buildDiagnostics(BASE)).toBe(
      [
        "LumaSync 1.5.5 · macOS",
        "Update channel: stable",
        "Mode: ambilight · outputs: usb, hue",
        "Local output: USB strip on /dev/cu.usbserial-1420 (CH340)",
        "LED layout: 164 LEDs (top 60, right 22, bottom 60, left 22)",
        "Hue: reachable, streaming",
        "Interface: 110% · motion: system · language: tr",
      ].join("\n"),
    );
  });

  // A WLED panel's only identity is its LAN address; it has no place in a public issue.
  it("never includes a network address", () => {
    const text = buildDiagnostics({ ...BASE, localSink: { transport: "wled", id: "192.168.1.40" } });

    expect(text).toContain("Local output: WLED panel");
    expect(text).not.toContain("192.168");
  });

  it("says what is missing rather than leaving a blank", () => {
    const text = buildDiagnostics({
      ...BASE,
      os: null,
      outputs: [],
      localSink: null,
      calibration: undefined,
      hue: { configured: false, reachable: false, streaming: false, reconnecting: false },
    });

    expect(text).toContain("LumaSync 1.5.5\n");
    expect(text).toContain("outputs: none");
    expect(text).toContain("Local output: none");
    expect(text).toContain("LED layout: not set up");
    expect(text).toContain("Hue: not set up");
  });
});
