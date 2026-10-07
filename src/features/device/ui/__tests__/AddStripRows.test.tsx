import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WLED_STATUS, type WledCommandStatus, type WledDeviceInfo } from "@/shared/contracts/device";

import type { WledConnectDeps } from "../../state/useWledConnect";
import type { UseDeviceConnectionResult } from "../../useDeviceConnection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const ensure = vi.hoisted(() => vi.fn<(port: string, previous: string | null) => Promise<unknown[]>>(async () => []));
vi.mock("../../model/usbStripRoster", () => ({ ensureStripForPort: ensure }));

import { FoundPortRow, WledAddressRow, type AddedOutput } from "../AddStripRows";

const DEVICE: WledDeviceInfo = { ip: "10.0.0.5", ledCount: 60 };
const status = (code: string): WledCommandStatus => ({ code, message: "raw", details: null }) as WledCommandStatus;

function deps(discovered: string): Required<WledConnectDeps> {
  return {
    discover: vi.fn<NonNullable<WledConnectDeps["discover"]>>(async () => ({
      status: status(discovered),
      devices: discovered === WLED_STATUS.DISCOVERY_OK ? [DEVICE] : [],
    })),
    connect: vi.fn<NonNullable<WledConnectDeps["connect"]>>(async () => ({ status: status(WLED_STATUS.CONNECT_OK) })),
  };
}

describe("WledAddressRow", () => {
  it("a mistyped address is caught before anything is asked", () => {
    const d = deps(WLED_STATUS.DISCOVERY_OK);
    render(<WledAddressRow onBound={async () => {}} onAdded={() => {}} primary deps={d} />);
    fireEvent.change(screen.getByTestId("wled-address-input"), { target: { value: "not an ip" } });
    fireEvent.click(screen.getByTestId("wled-address-add"));
    expect(screen.getByText("device:page.wled.invalidIp")).toBeInTheDocument();
    expect(d.discover).not.toHaveBeenCalled();
  });

  it("Add asks the device, binds it, records it, and hands over what was added", async () => {
    const d = deps(WLED_STATUS.DISCOVERY_OK);
    const onBound = vi.fn<(device: WledDeviceInfo) => Promise<void>>(async () => {});
    const onAdded = vi.fn<(added: AddedOutput) => void>();
    render(<WledAddressRow onBound={onBound} onAdded={onAdded} primary deps={d} />);

    fireEvent.change(screen.getByTestId("wled-address-input"), { target: { value: " 10.0.0.5 " } });
    fireEvent.keyDown(screen.getByTestId("wled-address-input"), { key: "Enter" });

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ kind: "wled", ip: "10.0.0.5" }));
    expect(d.discover).toHaveBeenCalledWith("10.0.0.5");
    expect(onBound).toHaveBeenCalledWith(DEVICE);
  });

  it("an address that is not WLED says so in the user's words", async () => {
    const d = deps(WLED_STATUS.PROTOCOL_MISMATCH);
    const onAdded = vi.fn<(added: AddedOutput) => void>();
    render(<WledAddressRow onBound={async () => {}} onAdded={onAdded} primary deps={d} />);

    fireEvent.change(screen.getByTestId("wled-address-input"), { target: { value: "10.0.0.5" } });
    fireEvent.click(screen.getByTestId("wled-address-add"));

    expect(await screen.findByTestId("wled-address-failed")).toHaveTextContent("device:page.wled.status.protocolMismatch");
    expect(onAdded).not.toHaveBeenCalled();
  });
});

function device(overrides: Partial<UseDeviceConnectionResult> = {}): UseDeviceConnectionResult {
  return {
    status: "idle",
    ports: [],
    selectedPort: null,
    connectedPort: "/dev/cu.old",
    lastSuccessfulPort: undefined,
    statusCard: null,
    isScanning: false,
    isConnecting: false,
    isReconnecting: false,
    isHealthChecking: false,
    activeOperation: "idle" as UseDeviceConnectionResult["activeOperation"],
    latestHealthCheck: null,
    isConnected: true,
    refreshPorts: async () => {},
    selectPort: vi.fn<UseDeviceConnectionResult["selectPort"]>(),
    connectSelectedPort: vi.fn<UseDeviceConnectionResult["connectSelectedPort"]>(async () => true),
    runHealthCheck: async () => {},
    ...overrides,
  };
}

const PORT = { portName: "COM3", product: "CH340", isSupported: true, sortKey: "COM3" };

describe("FoundPortRow", () => {
  it("Add connects the port, puts its strip in the room map, and hands over what was added", async () => {
    const dev = device();
    const onAdded = vi.fn<(added: AddedOutput) => void>();
    render(<FoundPortRow port={PORT} device={dev} primary onAdded={onAdded} />);

    fireEvent.click(screen.getByTestId("found-port-add"));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ kind: "serial", portName: "COM3" }));
    expect(dev.selectPort).toHaveBeenCalledWith("COM3");
    // The port driving until now decides whether an unlinked placement is this strip's.
    expect(ensure).toHaveBeenCalledWith("COM3", "/dev/cu.old");
  });

  it("a connect that fails adds nothing and writes nothing", async () => {
    ensure.mockClear();
    const dev = device({ connectSelectedPort: vi.fn<UseDeviceConnectionResult["connectSelectedPort"]>(async () => false) });
    const onAdded = vi.fn<(added: AddedOutput) => void>();
    render(<FoundPortRow port={PORT} device={dev} primary onAdded={onAdded} />);

    fireEvent.click(screen.getByTestId("found-port-add"));
    await waitFor(() => expect(dev.connectSelectedPort).toHaveBeenCalled());
    expect(onAdded).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("a failed connect of this port is told under it", () => {
    render(
      <FoundPortRow
        port={PORT}
        device={device({ selectedPort: "COM3", statusCard: { variant: "error", code: "CONNECT_IO_ERROR", message: "busy" } })}
        primary
        onAdded={() => {}}
      />,
    );
    expect(screen.getByTestId("strip-connect-error")).toHaveTextContent(
      "device:healthCheck.serialHealthCodes.CONNECT_IO_ERROR.label",
    );
  });
});
