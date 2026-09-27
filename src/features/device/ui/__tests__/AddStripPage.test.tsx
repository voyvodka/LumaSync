import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DevicePort } from "../../types";
import type { UseDeviceConnectionResult } from "../../useDeviceConnection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../model/usbStripRoster", () => ({ ensureStripForPort: async () => [] }));

import { AddStripPage } from "../AddStripPage";

const device = { isConnecting: false, selectedPort: null, statusCard: null } as unknown as UseDeviceConnectionResult;
const port = (portName: string, isSupported: boolean, product?: string): DevicePort => ({ portName, isSupported, sortKey: portName, product });

function renderPage(ports: DevicePort[], otherPorts: DevicePort[], replaces: string | null = null) {
  return render(
    <AddStripPage
      isActive
      title="device:strip.add.title"
      ports={ports}
      otherPorts={otherPorts}
      device={device}
      onWledBound={async () => {}}
      replaces={replaces}
      onAdded={() => {}}
    />,
  );
}

describe("AddStripPage", () => {
  it("with nothing plugged in, says where a controller will show, and WLED takes the amber", () => {
    renderPage([], []);
    expect(screen.getByTestId("add-strip-usb")).toHaveTextContent("device:strip.add.usbNone");
    expect(screen.queryByTestId("found-port")).toBeNull();
  });

  it("lists each supported controller with its own Add", () => {
    renderPage([port("/dev/cu.a", true, "CH340"), port("/dev/cu.b", true, "CP2102")], []);
    expect(screen.getAllByTestId("found-port")).toHaveLength(2);
  });

  // They explain an empty list without inviting a click.
  it("folds the ports LumaSync will not open, named only when asked", () => {
    renderPage([], [port("/dev/cu.Bluetooth-Incoming-Port", false), port("/dev/cu.debug-console", false)]);
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

  it("says which strip moves before anything is added", () => {
    renderPage([], [], "Desk");
    expect(screen.getByTestId("add-strip-replaces")).toHaveTextContent("device:strip.add.replaces");
  });
});
