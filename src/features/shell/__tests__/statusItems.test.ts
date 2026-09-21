import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

import type { LocalSink } from "@/features/device/localSink";
import { buildStatusItems, type StatusItemsInput } from "../statusItems";

const t = ((key: string) => key) as unknown as TFunction;

const healthy: StatusItemsInput = {
  ambilightActive: true,
  localSink: { transport: "serial", id: "/dev/cu.usbserial-1420" } satisfies LocalSink,
  hueStreaming: true,
  hueReachable: true,
  hueConfigured: true,
  onOpenDevices: () => {},
};

function byLabel(input: StatusItemsInput, label: string) {
  const item = buildStatusItems(input, t).find((i) => i.label === label);
  if (!item) throw new Error(`no ${label} chip`);
  return item;
}

describe("buildStatusItems", () => {
  it("emits CAP, USB and HUE in mockup order", () => {
    expect(buildStatusItems(healthy, t).map((i) => i.label)).toEqual(["CAP", "USB", "HUE"]);
  });

  it("never uses colour as the sole indicator — every chip carries a state string", () => {
    const permutations: StatusItemsInput[] = [
      healthy,
      { ...healthy, ambilightActive: false },
      { ...healthy, localSink: null },
      { ...healthy, hueStreaming: false },
      { ...healthy, hueStreaming: false, hueReachable: false },
      { ...healthy, hueStreaming: false, hueReachable: false, hueConfigured: false },
    ];
    for (const input of permutations) {
      for (const item of buildStatusItems(input, t)) {
        expect(item.state.length).toBeGreaterThan(0);
        expect(item.kind.length).toBeGreaterThan(0);
      }
    }
  });

  it("marks CAP ok only while ambilight is running", () => {
    expect(byLabel(healthy, "CAP")).toMatchObject({ state: "OK", kind: "ok" });
    expect(byLabel({ ...healthy, ambilightActive: false }, "CAP")).toMatchObject({
      state: "—",
      kind: "idle",
    });
  });

  it("walks the Hue chip down streaming → reachable → configured → off", () => {
    expect(byLabel(healthy, "HUE")).toMatchObject({ state: "STREAMING", kind: "active" });
    expect(byLabel({ ...healthy, hueStreaming: false }, "HUE")).toMatchObject({
      state: "OK",
      kind: "ok",
    });
    expect(
      byLabel({ ...healthy, hueStreaming: false, hueReachable: false }, "HUE"),
    ).toMatchObject({ state: "IDLE", kind: "idle" });
    expect(
      byLabel(
        { ...healthy, hueStreaming: false, hueReachable: false, hueConfigured: false },
        "HUE",
      ),
    ).toMatchObject({ state: "OFF", kind: "off" });
  });

  it("offers the reconnect deep-link exactly when a chip is unhealthy", () => {
    expect(byLabel(healthy, "USB").onReconnect).toBeUndefined();
    expect(byLabel(healthy, "HUE").onReconnect).toBeUndefined();
    // Reachable-but-not-streaming is still healthy enough to hide the affordance.
    expect(byLabel({ ...healthy, hueStreaming: false }, "HUE").onReconnect).toBeUndefined();

    const onOpenDevices = vi.fn();
    const unhealthy = { ...healthy, localSink: null, hueStreaming: false, hueReachable: false, onOpenDevices };
    byLabel(unhealthy, "USB").onReconnect?.();
    byLabel(unhealthy, "HUE").onReconnect?.();
    expect(onOpenDevices).toHaveBeenCalledTimes(2);
  });

  it("always labels the reconnect buttons for screen readers", () => {
    const unhealthy = { ...healthy, localSink: null, hueStreaming: false, hueReachable: false };
    expect(byLabel(unhealthy, "USB").reconnectAriaLabel).toBe(
      "shell:statusBar.reconnect.usbAriaLabel",
    );
    expect(byLabel(unhealthy, "HUE").reconnectAriaLabel).toBe(
      "shell:statusBar.reconnect.hueAriaLabel",
    );
  });

  // The chip used to read "USB OFF" for the whole life of a WLED-only
  // session, next to lights the app was actively driving.
  it("names the transport that is actually bound", () => {
    const wled = {
      ...healthy,
      localSink: { transport: "wled", id: "192.168.1.42" } satisfies LocalSink,
    };
    expect(byLabel(wled, "WLED").state).toBe("OK");
    expect(buildStatusItems(wled, t).map((i) => i.label)).toEqual(["CAP", "WLED", "HUE"]);
  });

  it("falls back to the USB label when nothing local is bound", () => {
    expect(byLabel({ ...healthy, localSink: null }, "USB").state).toBe("OFF");
  });
});
