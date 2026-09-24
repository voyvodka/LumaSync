// Devices → USB as a first-run user meets it: which ports can be connected,
// what one Connect does, and where the strip's own settings live.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DevicePort } from "@/features/device/types";
import type { UseDeviceConnectionResult } from "@/features/device/useDeviceConnection";
import { DEFAULT_ROOM_MAP, type UsbStripPlacement } from "@/shared/contracts/roomMap";
import type { ShellState } from "@/shared/contracts/shell";

import { UsbStripsCategory } from "../UsbStripsCategory";

const { stateRef, saveMock, writeGate } = vi.hoisted(() => ({
  stateRef: { current: {} as Partial<ShellState> },
  saveMock: vi.fn<(partial: Partial<ShellState>) => void>(),
  /** Set to hold roster writes open, as a slow disk would. */
  writeGate: { current: null as Promise<void> | null },
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
    // The revision-guarded write, minus the guard: one writer here.
    update: async (fn: (current: ShellState) => Partial<ShellState> | null) => {
      await writeGate.current;
      const partial = fn(stateRef.current as ShellState);
      if (partial) {
        saveMock(partial);
        stateRef.current = { ...stateRef.current, ...partial };
      }
      return stateRef.current as ShellState;
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

/** The page as DeviceSection mounts it: the roster is state it writes back to. */
function LivePage({ connection, initial = [] }: { connection: UseDeviceConnectionResult; initial?: UsbStripPlacement[] }) {
  const [pairedStrips, setPairedStrips] = useState<UsbStripPlacement[]>(initial);
  return (
    <UsbStripsCategory
      isActive
      device={connection}
      pairedStrips={pairedStrips}
      setPairedStrips={setPairedStrips}
      persistError={false}
      flagPersistError={() => {}}
      clearPersistError={() => {}}
    />
  );
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
  writeGate.current = null;
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
    // Empty, not hidden: a live region must already be in the tree when its
    // first status arrives, or that status is not announced.
    const status = screen.getByTestId("usb-status");
    expect(status).not.toHaveAttribute("hidden");
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveAttribute("role", "status");
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

  // Between the connect landing and the roster write, the connected port was
  // briefly unlisted, and "Add connected strip" flashed up live.
  it("does not offer to add the strip it is already adding", async () => {
    let releaseWrite!: () => void;
    writeGate.current = new Promise((resolve) => { releaseWrite = resolve; });
    const idle = device({ ports: [STRIP_PORT] });
    const connected = { ...idle, connectedPort: STRIP_PORT.portName, isConnected: true, status: "connected" as const };
    const view = render(<LivePage connection={idle} />);
    await act(async () => {});

    await userEvent.setup().click(screen.getByRole("button", CONNECT));
    // The controller's state lands before the roster write does.
    view.rerender(<LivePage connection={connected} />);
    expect(screen.queryByTestId("usb-paired-unlisted")).toBeNull();

    await act(async () => { releaseWrite(); });
    await waitFor(() => expect(screen.getAllByTestId("usb-paired-strip")).toHaveLength(1));
    expect(screen.queryByTestId("usb-paired-unlisted")).toBeNull();
  });

  // The drawn strip belonged to the controller already connected; a second
  // one got it relabelled instead of a strip of its own.
  it("gives a second controller its own strip rather than taking the drawn one", async () => {
    const drawn: UsbStripPlacement = { stripId: "usb-drawn", startX: 1, startY: 1, endX: 4, endY: 1, ledCount: 120 };
    stateRef.current = { roomMap: { ...DEFAULT_ROOM_MAP, usbStrips: [drawn] } };
    const secondPort: DevicePort = { ...STRIP_PORT, portName: "/dev/cu.usbserial-2210" };
    const connection = device({
      ports: [STRIP_PORT, secondPort],
      connectedPort: STRIP_PORT.portName,
      lastSuccessfulPort: STRIP_PORT.portName,
      isConnected: true,
      status: "connected",
    });
    await renderCategory(connection, [drawn]);

    await userEvent.setup().click(screen.getByRole("button", CONNECT));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0][0].roomMap?.usbStrips).toEqual([
      drawn,
      expect.objectContaining({ portName: secondPort.portName }),
    ]);
  });

  it("offers no add-strip form beside the roster", async () => {
    await renderCategory(device({ ports: [STRIP_PORT] }));
    const roster = screen.getByTestId("usb-paired-strips");
    expect(within(roster).queryByRole("button")).toBeNull();
    expect(within(roster).getByText("device:page.usb.paired.empty")).toBeInTheDocument();
  });
});

describe("a paired strip row", () => {
  const listed: UsbStripPlacement = {
    stripId: "usb-a", startX: 1, startY: 1, endX: 4, endY: 1, ledCount: 60, portName: STRIP_PORT.portName,
  };

  // Every row has a Change port and an Open in map; a screen reader could not
  // tell whose.
  it("is a group named by its strip and port", async () => {
    await renderCategory(device({ ports: [STRIP_PORT] }), [listed]);
    const row = screen.getByRole("group", { name: `device:page.usb.paired.stripName ${STRIP_PORT.portName}` });
    expect(within(row).getByRole("button", { name: "device:page.usb.paired.changePort" })).toBeInTheDocument();
  });

  // Closing the editor unmounted the focused control and dropped focus on <body>.
  it.each([
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard("{Escape}"); }],
    ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: "device:page.usb.paired.changePortCancel" }));
    }],
    ["Enter", async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard("{Enter}"); }],
  ] as const)("hands focus back to Change port after %s", async (_how, close) => {
    await renderCategory(device({ ports: [STRIP_PORT] }), [listed]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "device:page.usb.paired.changePort" }));
    expect(screen.getByRole("combobox", { name: "device:page.usb.paired.portLabel" })).toHaveFocus();

    await close(user);

    expect(await screen.findByRole("button", { name: "device:page.usb.paired.changePort" })).toHaveFocus();
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

// The shared caps turned "Red", "Green", "Other colour / off" into 9.5px shouting.
it("keeps the colour-order answers, which are words, in sentence case", async () => {
  const { readStylesheet } = await import("@/test/stylesheetSource");
  const css = readStylesheet();
  const start = css.indexOf("\n.lm-color-order-answer {");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start), css.indexOf("}", start));
  expect(body).toMatch(/text-transform:\s*none/);
  expect(body).toMatch(/font-size:\s*11px/);
  // Declared after the button rules it overrides, in the same layer.
  expect(start).toBeGreaterThan(css.indexOf("\n.lm-btn-md {"));
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
