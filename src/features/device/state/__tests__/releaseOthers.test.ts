import { describe, expect, it, vi } from "vitest";

import type { LocalOutputsSnapshot } from "@/shared/contracts/device";

import { releaseOtherLocalOutputs, type ReleaseOthersDeps } from "../releaseOthers";

const strip = (portName: string, connected: boolean) =>
  ({
    kind: "serial",
    portName,
    connected,
    status: { code: connected ? "CONNECT_OK" : "DISCONNECTED", message: "m", details: null },
    firmware: null,
    updatedAtUnixMs: 0,
  }) as const;
const wled = (ip: string) => ({ kind: "wled", ip, ledCount: 60, connected: true }) as const;

function deps(outputs: LocalOutputsSnapshot["outputs"] | null) {
  return {
    read: vi.fn<ReleaseOthersDeps["read"]>().mockResolvedValue(outputs === null ? null : { revision: 1, outputs, driven: null }),
    disconnectSerial: vi.fn<ReleaseOthersDeps["disconnectSerial"]>().mockResolvedValue("SERIAL_DISCONNECT_OK"),
    forgetWled: vi.fn<ReleaseOthersDeps["forgetWled"]>().mockResolvedValue("WLED_FORGET_OK"),
  };
}

describe("releaseOtherLocalOutputs", () => {
  it("lets go of every other connected output after a strip is connected", async () => {
    const d = deps([strip("COM3", true), strip("COM4", true), strip("COM5", false), wled("10.0.0.5")]);

    await releaseOtherLocalOutputs({ kind: "serial", portName: "COM3" }, d);

    expect(d.disconnectSerial).toHaveBeenCalledTimes(1);
    expect(d.disconnectSerial).toHaveBeenCalledWith("COM4");
    expect(d.forgetWled).toHaveBeenCalledWith("10.0.0.5");
  });

  it("lets go of the strips after a WLED device is connected, and keeps the device", async () => {
    const d = deps([strip("COM3", true), wled("10.0.0.5")]);

    await releaseOtherLocalOutputs({ kind: "wled", ip: "10.0.0.5" }, d);

    expect(d.disconnectSerial).toHaveBeenCalledWith("COM3");
    expect(d.forgetWled).not.toHaveBeenCalled();
  });

  // Nothing else is connected: nothing is sent.
  it("does nothing when the kept output is the only one connected", async () => {
    const d = deps([strip("COM3", true), strip("COM4", false)]);

    await releaseOtherLocalOutputs({ kind: "serial", portName: "COM3" }, d);

    expect(d.disconnectSerial).not.toHaveBeenCalled();
    expect(d.forgetWled).not.toHaveBeenCalled();
  });

  it("does nothing when the registry could not be read", async () => {
    const d = deps(null);

    await releaseOtherLocalOutputs({ kind: "serial", portName: "COM3" }, d);

    expect(d.disconnectSerial).not.toHaveBeenCalled();
  });

  // Both commands answer with a code instead of throwing; a refusal is not lost.
  it("says so when a release is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps([strip("COM3", true), strip("COM4", true)]);
    d.disconnectSerial.mockResolvedValue("SERIAL_DISCONNECT_FAILED");

    await releaseOtherLocalOutputs({ kind: "serial", portName: "COM3" }, d);

    expect(warn).toHaveBeenCalledWith(expect.any(String), "SERIAL_DISCONNECT_FAILED");
  });

  it("goes on to the others when one release fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps([strip("COM3", true), strip("COM4", true), wled("10.0.0.5")]);
    d.disconnectSerial.mockRejectedValue(new Error("busy"));

    await expect(releaseOtherLocalOutputs({ kind: "serial", portName: "COM3" }, d)).resolves.toBeUndefined();

    expect(d.forgetWled).toHaveBeenCalledWith("10.0.0.5");
  });
});
