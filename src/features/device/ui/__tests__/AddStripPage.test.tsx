import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WledDiscoveryResponse } from "@/shared/contracts/device";

import type { DevicePort } from "../../types";
import type { UseDeviceConnectionResult } from "../../useDeviceConnection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../model/usbStripRoster", () => ({ ensureStripForPort: async () => [] }));
const browse = vi.hoisted(() => vi.fn<() => Promise<WledDiscoveryResponse>>());
// A WLED add that has not answered yet.
vi.mock("../../wledApi", () => ({
  discoverWledDevices: () => new Promise(() => {}),
  connectWledSink: () => new Promise(() => {}),
  browseWledDevices: browse,
}));

const browsed = (...ips: string[]): WledDiscoveryResponse => ({
  status: { code: "WLED_BROWSE_OK", message: "ok", details: null },
  devices: ips.map((ip) => ({ ip, ledCount: 60, name: `WLED ${ip}` })),
});

beforeEach(() => {
  browse.mockReset();
  browse.mockResolvedValue(browsed());
});


import { AddStripPage } from "../AddStripPage";

const device = { isConnecting: false, selectedPort: null, statusCard: null } as unknown as UseDeviceConnectionResult;
const port = (portName: string, isSupported: boolean, product?: string): DevicePort => ({ portName, isSupported, sortKey: portName, product });

// The page browses as it opens: rendered inside act, so the answer lands before the test goes on.
async function renderPage(
  ports: DevicePort[],
  otherPorts: DevicePort[],
  replaces: string | null = null,
  dev = device,
  boundWledIp: string | null = null,
) {
  await act(async () => {
    render(
      <AddStripPage
        isActive
        title="device:strip.add.title"
        ports={ports}
        otherPorts={otherPorts}
        device={dev}
        onWledBound={async () => {}}
        boundWledIp={boundWledIp}
        replaces={replaces}
        onAdded={() => {}}
      />,
    );
  });
}

describe("AddStripPage", () => {
  it("with nothing plugged in, says where a controller will show, and WLED takes the amber", async () => {
    await renderPage([], []);
    expect(screen.getByTestId("add-strip-usb")).toHaveTextContent("device:strip.add.usbNone");
    expect(screen.queryByTestId("found-port")).toBeNull();
  });

  it("lists each supported controller with its own Add", async () => {
    await renderPage([port("/dev/cu.a", true, "CH340"), port("/dev/cu.b", true, "CP2102")], []);
    expect(screen.getAllByTestId("found-port")).toHaveLength(2);
  });

  // They explain an empty list without inviting a click.
  it("folds the ports LumaSync will not open, named only when asked", async () => {
    await renderPage([], [port("/dev/cu.Bluetooth-Incoming-Port", false), port("/dev/cu.debug-console", false)]);
    const row = screen.getByTestId("add-strip-other-ports");
    expect(row).toHaveTextContent("2");
    const toggle = within(row).getByRole("button", { name: "device:strip.add.show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("device:strip.add.hide");
    expect(within(row).getByText("cu.Bluetooth-Incoming-Port")).toBeInTheDocument();
    expect(within(row).queryByTestId("found-port-add")).toBeNull();
  });

  it("says which strip moves before anything is added", async () => {
    await renderPage([], [], "Desk");
    expect(screen.getByTestId("add-strip-replaces")).toHaveTextContent("device:strip.add.replaces");
  });

  // Each add moves the one driven strip: two at once would race to write it.
  it("while a WLED add runs, a controller's Add waits", async () => {
    await renderPage([port("/dev/cu.a", true, "CH340")], []);
    expect(screen.getByTestId("found-port-add")).toBeEnabled();
    fireEvent.change(screen.getByTestId("wled-address-input"), { target: { value: "10.0.0.5" } });
    fireEvent.click(screen.getByTestId("wled-address-add"));
    expect(screen.getByTestId("found-port-add")).toBeDisabled();
  });

  it("while a controller connects, the WLED Add waits, Enter included", async () => {
    const connecting = { ...device, isConnecting: true, selectedPort: "/dev/cu.a" } as UseDeviceConnectionResult;
    await renderPage([port("/dev/cu.a", true, "CH340")], [], null, connecting);
    fireEvent.change(screen.getByTestId("wled-address-input"), { target: { value: "10.0.0.5" } });
    expect(screen.getByTestId("wled-address-add")).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId("wled-address-input"), { key: "Enter" });
    expect(screen.getByTestId("wled-address-add")).not.toHaveAttribute("aria-busy");
  });

  it("looks for WLED devices on opening and offers each one found, but not the one already added", async () => {
    let answer: (found: WledDiscoveryResponse) => void = () => {};
    browse.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderPage([], [], null, device, "10.0.0.7");
    expect(browse).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wled-browse-searching")).toHaveTextContent("device:strip.add.searching");

    await act(async () => answer(browsed("10.0.0.5", "10.0.0.7")));
    const rows = await screen.findAllByTestId("found-wled");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("WLED 10.0.0.5");
    expect(screen.getByTestId("wled-address-input")).toBeInTheDocument();
  });

  it("a browse that could not run leaves only the address row", async () => {
    browse.mockResolvedValue({ status: { code: "WLED_BROWSE_UNSUPPORTED", message: "", details: null }, devices: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderPage([], []);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByTestId("found-wled")).toBeNull();
    expect(screen.getByTestId("wled-address-input")).toBeInTheDocument();
    warn.mockRestore();
  });

  it("while a found WLED device is being added, the other Adds wait", async () => {
    browse.mockResolvedValue(browsed("10.0.0.5", "10.0.0.6"));
    await renderPage([port("/dev/cu.a", true, "CH340")], []);
    const [first, second] = await screen.findAllByTestId("found-wled-add");
    fireEvent.click(first);
    expect(second).toBeDisabled();
    expect(screen.getByTestId("found-port-add")).toBeDisabled();
    fireEvent.change(screen.getByTestId("wled-address-input"), { target: { value: "10.0.0.9" } });
    expect(screen.getByTestId("wled-address-add")).toBeDisabled();
  });
});
