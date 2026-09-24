// Devices → USB as a first-run user meets it: which ports can be connected,
// what one Connect does, and where the strip's own settings live.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DevicePort } from "@/features/device/types";
import type { UseDeviceConnectionResult } from "@/features/device/useDeviceConnection";
import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import type { ShellState } from "@/shared/contracts/shell";

import { UsbStripsCategory } from "../UsbStripsCategory";

const { stateRef, saveMock } = vi.hoisted(() => ({
  stateRef: { current: {} as Partial<ShellState> },
  saveMock: vi.fn<(partial: Partial<ShellState>) => void>(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(stateRef.current),
    save: (partial: Partial<ShellState>) => {
      saveMock(partial);
      stateRef.current = { ...stateRef.current, ...partial };
      return Promise.resolve();
    },
  },
}));

const STRIP_PORT: DevicePort = {
  portName: "/dev/cu.usbserial-1420",
  isSupported: true,
  sortKey: "ch340",
  vid: 0x1a86,
  pid: 0x7523,
  manufacturer: "wch.cn",
  product: "CH340 USB Serial",
};
const BLUETOOTH: DevicePort = { portName: "/dev/cu.Bluetooth-Incoming-Port", isSupported: false, sortKey: "bt" };
const DEBUG_CONSOLE: DevicePort = { portName: "/dev/cu.debug-console", isSupported: false, sortKey: "dbg" };

function device(overrides: Partial<UseDeviceConnectionResult> = {}): UseDeviceConnectionResult {
  return {
    status: "ready",
    ports: [],
    selectedPort: null,
    connectedPort: null,
    statusCard: null,
    canConnect: false,
    isScanning: false,
    isConnecting: false,
    isReconnecting: false,
    isHealthChecking: false,
    activeOperation: "idle",
    latestHealthCheck: null,
    isConnected: false,
    refreshPorts: vi.fn<UseDeviceConnectionResult["refreshPorts"]>().mockResolvedValue(undefined),
    selectPort: vi.fn<UseDeviceConnectionResult["selectPort"]>(),
    connectSelectedPort: vi.fn<UseDeviceConnectionResult["connectSelectedPort"]>().mockResolvedValue(true),
    runHealthCheck: vi.fn<UseDeviceConnectionResult["runHealthCheck"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function renderCategory(connection: UseDeviceConnectionResult, pairedStrips: UsbStripPlacement[] = []) {
  const setPairedStrips = vi.fn<(next: UsbStripPlacement[]) => void>();
  render(
    <UsbStripsCategory
      isActive
      device={connection}
      pairedStrips={pairedStrips}
      setPairedStrips={(next) => setPairedStrips(typeof next === "function" ? next(pairedStrips) : next)}
      persistError={false}
      flagPersistError={() => {}}
      clearPersistError={() => {}}
    />,
  );
  // The strip settings read the store, then their pickers read it again.
  await act(async () => {});
  await act(async () => {});
  return { setPairedStrips };
}

const CONNECT = { name: "device:page.usb.connect" };

beforeEach(() => {
  stateRef.current = {};
  saveMock.mockClear();
});

describe("which ports the page offers", () => {
  // Both ports on the maintainer's machine fail the allowlist, and the page
  // still invited connecting them.
  it("never offers to connect a port that fails the allowlist", async () => {
    await renderCategory(device({ ports: [BLUETOOTH, DEBUG_CONSOLE] }));

    expect(screen.queryByRole("button", CONNECT)).toBeNull();
    const other = screen.getByTestId("usb-other-ports");
    expect(other).not.toHaveAttribute("open");
    expect(within(other).getAllByText("device:page.usb.pill.unsupported")).toHaveLength(2);
    expect(within(other).queryAllByRole("button")).toHaveLength(0);
  });

  it("says why nothing can connect when every port is unsupported", async () => {
    await renderCategory(device({ ports: [BLUETOOTH] }));

    const status = screen.getByTestId("usb-status");
    expect(within(status).getByText("device:status.noSupportedTitle")).toBeInTheDocument();
    expect(within(status).getByText("device:status.noSupportedBody")).toBeInTheDocument();
  });

  it("gives each supported port one Connect, and keeps the others apart", async () => {
    await renderCategory(device({ ports: [STRIP_PORT, BLUETOOTH] }));

    const cards = screen.getAllByTestId("usb-port-card");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByRole("button", CONNECT)).toBeEnabled();
    expect(within(cards[0]).getByText("1A86:7523")).toBeInTheDocument();
    expect(screen.getAllByRole("button", CONNECT)).toHaveLength(1);
    // Card-level selection is gone: the card is a group, not a button.
    expect(cards[0]).toHaveAttribute("role", "group");
    expect(within(screen.getByTestId("usb-status")).getByText("device:status.idleTitle")).toBeInTheDocument();
  });

  it("shows an empty state with a Rescan when nothing enumerates", async () => {
    const connection = device();
    await renderCategory(connection);

    expect(screen.getByText("device:status.noPortsTitle")).toBeInTheDocument();
    expect(screen.getByTestId("usb-status")).toHaveAttribute("hidden");
    const controller = screen.getByTestId("usb-controller");
    await userEvent.setup().click(within(controller).getByRole("button", { name: "device:page.actions.rescan" }));
    expect(connection.refreshPorts).toHaveBeenCalled();
  });
});

describe("Connect is the one way a strip is added", () => {
  it("connects the port and adds its strip to the roster once", async () => {
    stateRef.current = { ledCalibration: { totalLeds: 96 } as ShellState["ledCalibration"] };
    const connection = device({ ports: [STRIP_PORT] });
    const { setPairedStrips } = await renderCategory(connection);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", CONNECT));

    expect(connection.selectPort).toHaveBeenCalledWith(STRIP_PORT.portName);
    expect(connection.connectSelectedPort).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const strips = saveMock.mock.calls[0][0].roomMap?.usbStrips ?? [];
    expect(strips).toEqual([expect.objectContaining({ portName: STRIP_PORT.portName, ledCount: 96 })]);
    expect(setPairedStrips).toHaveBeenLastCalledWith(strips);

    // A second connect of the same controller finds it listed and writes nothing.
    await user.click(screen.getByRole("button", CONNECT));
    await waitFor(() => expect(connection.connectSelectedPort).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setPairedStrips).toHaveBeenCalledTimes(2));
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("adds nothing when the connect fails", async () => {
    const connection = device({
      ports: [STRIP_PORT],
      connectSelectedPort: vi.fn<UseDeviceConnectionResult["connectSelectedPort"]>().mockResolvedValue(false),
    });
    const { setPairedStrips } = await renderCategory(connection);

    await userEvent.setup().click(screen.getByRole("button", CONNECT));

    await waitFor(() => expect(connection.connectSelectedPort).toHaveBeenCalled());
    expect(saveMock).not.toHaveBeenCalled();
    expect(setPairedStrips).not.toHaveBeenCalled();
  });

  // A setup from before the roster reconnects at boot with an empty list; the
  // page said "No strips yet" under "Connection established".
  it("says a connected strip is missing from the list, and adds it only when asked", async () => {
    stateRef.current = { ledCalibration: { totalLeds: 120 } as ShellState["ledCalibration"] };
    const connection = device({ ports: [STRIP_PORT], connectedPort: STRIP_PORT.portName, isConnected: true, status: "connected" });
    const { setPairedStrips } = await renderCategory(connection);

    const roster = screen.getByTestId("usb-paired-strips");
    expect(within(roster).getByText("device:page.usb.paired.unlisted")).toBeInTheDocument();
    expect(within(roster).queryByText("device:page.usb.paired.empty")).toBeNull();
    expect(saveMock).not.toHaveBeenCalled();

    await userEvent.setup().click(within(roster).getByRole("button", { name: "device:page.usb.paired.addConnected" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0][0].roomMap?.usbStrips).toEqual([
      expect.objectContaining({ portName: STRIP_PORT.portName, ledCount: 120 }),
    ]);
    expect(setPairedStrips).toHaveBeenCalledTimes(1);
    expect(connection.connectSelectedPort).not.toHaveBeenCalled();
  });

  it("says nothing extra when the connected strip is listed", async () => {
    const listed: UsbStripPlacement = {
      stripId: "usb-a", startX: 1, startY: 1, endX: 4, endY: 1, ledCount: 60, portName: STRIP_PORT.portName,
    };
    await renderCategory(
      device({ ports: [STRIP_PORT], connectedPort: STRIP_PORT.portName, isConnected: true, status: "connected" }),
      [listed],
    );
    expect(screen.queryByTestId("usb-paired-unlisted")).toBeNull();
    expect(screen.getAllByTestId("usb-paired-strip")).toHaveLength(1);
  });

  it("offers no add-strip form beside the roster", async () => {
    await renderCategory(device({ ports: [STRIP_PORT] }));
    const roster = screen.getByTestId("usb-paired-strips");
    expect(within(roster).queryByRole("button")).toBeNull();
    expect(within(roster).getByText("device:page.usb.paired.empty")).toBeInTheDocument();
  });
});

// "CONNECT" and "Change port" sat side by side: every button size now shares one case.
it("gives every button size on the page the same case", async () => {
  const { readStylesheet } = await import("@/test/stylesheetSource");
  const css = readStylesheet();
  for (const selector of [".lm-btn", ".lm-btn-md", ".lm-dcard-act"]) {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf("{", start), css.indexOf("}", start));
    expect(body, selector).toMatch(/text-transform:\s*uppercase/);
  }
});

describe("strip settings", () => {
  it("holds firmware profile, chip type and colour order, between controller and roster", async () => {
    await renderCategory(device({ ports: [STRIP_PORT] }));

    const settings = screen.getByTestId("usb-strip-settings");
    expect(await within(settings).findByRole("radiogroup", { name: "lights:led.firmwareProfile.title" })).toBeInTheDocument();
    expect(within(settings).getByRole("radiogroup", { name: "lights:led.chipType.label" })).toBeInTheDocument();
    expect(within(settings).getByText("lights:led.colorOrder.label")).toBeInTheDocument();

    const controller = screen.getByTestId("usb-controller");
    const roster = screen.getByTestId("usb-paired-strips");
    expect(controller.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(settings.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The chip picker was mounted without the profile, so this never showed.
  it("warns about SK6812 under the saved Adalight profile", async () => {
    stateRef.current = { firmwareProfile: "adalight", selectedChipType: "sk6812-rgbw" };
    await renderCategory(device());

    expect(await screen.findByText("lights:led.chipType.sk6812AdalightWarning")).toBeInTheDocument();
  });

  it("warns as soon as Adalight is picked on the same page", async () => {
    stateRef.current = { firmwareProfile: "lumasync-v1", selectedChipType: "sk6812-rgbw" };
    await renderCategory(device());
    const adalight = await screen.findByRole("radio", { name: /lights:led.firmwareProfile.adalightLabel/ });
    expect(screen.queryByText("lights:led.chipType.sk6812AdalightWarning")).toBeNull();

    await userEvent.setup().click(adalight);

    expect(await screen.findByText("lights:led.chipType.sk6812AdalightWarning")).toBeInTheDocument();
  });
});
