import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

import type { LocalSink } from "@/features/device/localSink";
import { HUE_LEFT_OUT_REASON } from "@/shared/contracts/lighting";

import { buildStatusItems, resolveHueHeldOut, type HueHeldOutInput, type StatusItemsInput } from "../statusItems";

const t = ((key: string) => key) as unknown as TFunction;

const S = {
  ok: "shell:statusBar.state.ok",
  off: "shell:statusBar.state.off",
  idle: "shell:statusBar.state.idle",
  streaming: "shell:statusBar.state.streaming",
  retrying: "shell:statusBar.state.retrying",
  failed: "shell:statusBar.state.failed",
  waiting: "shell:statusBar.state.waiting",
  leftOut: "shell:statusBar.state.leftOut",
} as const;

const healthy: StatusItemsInput = {
  ambilightActive: true,
  localSink: { transport: "serial", id: "/dev/cu.usbserial-1420" } satisfies LocalSink,
  hueStreaming: true,
  hueReconnecting: false,
  hueFailed: false,
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
    expect(byLabel(healthy, "CAP")).toMatchObject({ state: S.ok, kind: "ok" });
    expect(byLabel({ ...healthy, ambilightActive: false }, "CAP")).toMatchObject({
      state: "—",
      kind: "idle",
    });
  });

  it("walks the Hue chip down streaming → reachable → configured → off", () => {
    expect(byLabel(healthy, "HUE")).toMatchObject({ state: S.streaming, kind: "active" });
    expect(byLabel({ ...healthy, hueStreaming: false }, "HUE")).toMatchObject({
      state: S.ok,
      kind: "ok",
    });
    expect(
      byLabel({ ...healthy, hueStreaming: false, hueReachable: false }, "HUE"),
    ).toMatchObject({ state: S.idle, kind: "idle" });
    expect(
      byLabel(
        { ...healthy, hueStreaming: false, hueReachable: false, hueConfigured: false },
        "HUE",
      ),
    ).toMatchObject({ state: S.off, kind: "off" });
  });

  // The health reconciler drops "hue" from the active targets on Failed, so
  // with a reachable bridge the chip used to fall through to a green OK.
  it("reads a failed Hue stream as failed and links to Devices, even with the bridge reachable", () => {
    const onOpenDevices = vi.fn<StatusItemsInput["onOpenDevices"]>();
    const item = byLabel({ ...healthy, hueStreaming: false, hueFailed: true, onOpenDevices }, "HUE");
    expect(item).toMatchObject({ state: S.failed, kind: "error" });
    item.onReconnect?.();
    expect(onOpenDevices).toHaveBeenCalledWith("hue");
  });

  // A bridge unreachable for hours kept "hue" in the active targets, so the
  // chip read STREAMING while the Devices card said Reconnecting.
  it("reads a retrying Hue session as retrying, never as streaming", () => {
    const item = byLabel({ ...healthy, hueReconnecting: true, hueReachable: false }, "HUE");
    expect(item).toMatchObject({ state: S.retrying, kind: "active" });
    // The backend is already retrying; a second retry affordance would lie.
    expect(item.onReconnect).toBeUndefined();
  });

  it("offers the reconnect deep-link exactly when a chip is unhealthy", () => {
    expect(byLabel(healthy, "USB").onReconnect).toBeUndefined();
    expect(byLabel(healthy, "HUE").onReconnect).toBeUndefined();
    // Reachable-but-not-streaming is still healthy enough to hide the affordance.
    expect(byLabel({ ...healthy, hueStreaming: false }, "HUE").onReconnect).toBeUndefined();

    const onOpenDevices = vi.fn<StatusItemsInput["onOpenDevices"]>();
    const unhealthy = { ...healthy, localSink: null, hueStreaming: false, hueReachable: false, onOpenDevices };
    byLabel(unhealthy, "USB").onReconnect?.();
    byLabel(unhealthy, "HUE").onReconnect?.();
    expect(onOpenDevices).toHaveBeenCalledTimes(2);
  });

  // The link used to open Devices on whichever category was last open.
  it("opens each chip's own Devices category", () => {
    const onOpenDevices = vi.fn<StatusItemsInput["onOpenDevices"]>();
    const unhealthy = { ...healthy, localSink: null, hueStreaming: false, hueReachable: false, onOpenDevices };
    byLabel(unhealthy, "USB").onReconnect?.();
    expect(onOpenDevices).toHaveBeenLastCalledWith("usb");
    byLabel(unhealthy, "HUE").onReconnect?.();
    expect(onOpenDevices).toHaveBeenLastCalledWith("hue");
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
    expect(byLabel(wled, "WLED").state).toBe(S.ok);
    expect(buildStatusItems(wled, t).map((i) => i.label)).toEqual(["CAP", "WLED", "HUE"]);
  });

  it("falls back to the USB label when nothing local is bound", () => {
    expect(byLabel({ ...healthy, localSink: null }, "USB").state).toBe(S.off);
  });

  // A bridge the boot retry is waiting on answers the reachability probe, so
  // the chip read OK beside the notice saying Hue was not running.
  it("reads a Hue waiting on a busy bridge as waiting, never as OK", () => {
    const item = byLabel({ ...healthy, hueStreaming: false, hueHeldOut: "waiting" }, "HUE");
    expect(item).toMatchObject({ state: S.waiting, kind: "active" });
    // The app is already waiting on the bridge; a reconnect affordance would lie.
    expect(item.onReconnect).toBeUndefined();
  });

  it("reads a Hue left out of the running mode as left out and links to Devices, even with the bridge reachable", () => {
    const onOpenDevices = vi.fn<StatusItemsInput["onOpenDevices"]>();
    const item = byLabel({ ...healthy, hueStreaming: false, hueHeldOut: "leftOut", onOpenDevices }, "HUE");
    expect(item).toMatchObject({ state: S.leftOut, kind: "error" });
    item.onReconnect?.();
    expect(onOpenDevices).toHaveBeenCalledWith("hue");
  });

  it("routes every chip value through the catalogue", () => {
    const permutations: StatusItemsInput[] = [
      healthy,
      { ...healthy, localSink: null, hueStreaming: false, hueReachable: false },
      { ...healthy, hueStreaming: false, hueReachable: false, hueConfigured: false },
      { ...healthy, hueReconnecting: true },
      { ...healthy, hueStreaming: false, hueFailed: true },
      { ...healthy, hueStreaming: false, hueHeldOut: "waiting" },
      { ...healthy, hueStreaming: false, hueHeldOut: "leftOut" },
    ];
    for (const input of permutations) {
      for (const item of buildStatusItems(input, t)) {
        if (item.state !== "—") expect(item.state).toMatch(/^shell:statusBar\.state\./);
      }
    }
  });
});

describe("resolveHueHeldOut", () => {
  const running: HueHeldOutInput = {
    leftOutReason: null,
    bootHueRetry: null,
    lightingRunning: true,
    hueSessionActive: false,
  };

  it("is waiting while a [usb, hue] restore waits to add Hue back", () => {
    expect(resolveHueHeldOut({ ...running, leftOutReason: HUE_LEFT_OUT_REASON.BUSY })).toBe("waiting");
  });

  it("is waiting while a restore that ended Off waits for the bridge", () => {
    expect(resolveHueHeldOut({ ...running, lightingRunning: false, bootHueRetry: "waiting" })).toBe("waiting");
  });

  it.each([
    HUE_LEFT_OUT_REASON.UNREACHABLE,
    HUE_LEFT_OUT_REASON.AUTH,
    HUE_LEFT_OUT_REASON.CONFIG,
    HUE_LEFT_OUT_REASON.BUSY_GAVE_UP,
  ])("is left out after a %s refusal while the mode runs", (reason) => {
    expect(resolveHueHeldOut({ ...running, leftOutReason: reason })).toBe("leftOut");
  });

  it("is nothing once Hue is part of the running output, or nothing runs", () => {
    expect(resolveHueHeldOut({ ...running, leftOutReason: HUE_LEFT_OUT_REASON.BUSY, hueSessionActive: true })).toBeNull();
    expect(resolveHueHeldOut({ ...running, leftOutReason: HUE_LEFT_OUT_REASON.UNREACHABLE, lightingRunning: false })).toBeNull();
    expect(resolveHueHeldOut(running)).toBeNull();
  });
});
