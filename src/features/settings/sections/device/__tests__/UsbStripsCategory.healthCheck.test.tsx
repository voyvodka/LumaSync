// The health-check step list through the real device hook and the real
// Turkish catalogue, with only the Tauri boundary faked. Rust writes every
// step's `message` in English; a Turkish user must see the catalogue text.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "@/features/i18n/i18n";
import { useDeviceConnection } from "@/features/device/useDeviceConnection";
import type { HealthCheckResult, HealthStepResult } from "@/features/device/deviceConnectionApi";
import tr from "@/locales/tr/device";
import { UsbStripsCategory } from "../UsbStripsCategory";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({}),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

// Both make their own store and IPC reads that this test has no interest in.
vi.mock("../../control/LedChipTypePicker", () => ({ LedChipTypePicker: () => null }));
vi.mock("../../control/LedColorOrderControl", () => ({ LedColorOrderControl: () => null }));

const PORT = "/dev/cu.usbserial-110";

let healthCheck: HealthCheckResult;

function answer(command: string): unknown {
  switch (command) {
    case "list_serial_ports":
      return {
        status: { code: "LIST_PORTS_OK", message: "ok", details: null },
        ports: [
          {
            name: PORT,
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
        ],
      };
    case "get_serial_connection_status":
    case "connect_serial_port":
      return {
        portName: PORT,
        connected: true,
        status: { code: "CONNECT_OK", message: "Connected.", details: null },
        updatedAtUnixMs: 0,
      };
    case "run_serial_health_check":
      return healthCheck;
    default:
      return undefined;
  }
}

/** The four steps exactly as `run_serial_health_check_blocking` writes them. */
function rustSteps(handshake: HealthStepResult): HealthStepResult[] {
  return [
    {
      step: "PORT_VISIBLE",
      pass: true,
      code: "PORT_VISIBLE",
      message: "Port is visible in serial inventory.",
      details: null,
    },
    {
      step: "PORT_SUPPORTED",
      pass: true,
      code: "PORT_SUPPORTED",
      message: "Port matches supported USB adapter allowlist.",
      details: "VID=1A86, PID=7523",
    },
    {
      step: "CONNECT_AND_VERIFY",
      pass: true,
      code: "CONNECT_OK",
      message: "Port opened successfully at 115200 baud.",
      details: null,
    },
    handshake,
  ];
}

function Harness() {
  const device = useDeviceConnection();
  return (
    <UsbStripsCategory
      isActive
      device={device}
      pairedStrips={[]}
      setPairedStrips={() => {}}
      persistError={false}
      flagPersistError={() => {}}
      clearPersistError={() => {}}
    />
  );
}

async function runHealthCheck() {
  const user = userEvent.setup();
  render(<Harness />);
  const action = await screen.findByRole("button", { name: tr.healthCheck.runAction });
  await waitFor(() => expect(action).toBeEnabled());
  await user.click(action);
  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("run_serial_health_check", { portName: PORT });
  });
}

const codes = tr.healthCheck.serialHealthCodes;

describe("UsbStripsCategory — health check steps in the user's language", () => {
  beforeAll(async () => {
    await initI18n("tr");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => Promise.resolve(answer(command)));
  });

  it("renders a failed handshake from the catalogue, not Rust's English", async () => {
    healthCheck = {
      pass: false,
      checkedAtUnixMs: 0,
      roundTripMs: null,
      firmwareVersion: null,
      advertisedFirmwareProfile: null,
      steps: rustSteps({
        step: "HANDSHAKE",
        pass: false,
        code: "SERIAL_HEALTH_HANDSHAKE_TIMEOUT",
        message: "Handshake timed out: no response from firmware within 2 s.",
        details: "If using non-LumaSync firmware, switch to the Adalight profile in Device settings.",
      }),
    };

    await runHealthCheck();

    const handshake = await screen.findByTestId("health-step-HANDSHAKE");
    expect(within(handshake).getByText(codes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.label)).toBeInTheDocument();
    expect(within(handshake).getByText(codes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.hint)).toBeInTheDocument();

    const visible = screen.getByTestId("health-step-PORT_VISIBLE");
    expect(within(visible).getByText(codes.PORT_VISIBLE.label)).toBeInTheDocument();
    // VID/PID is data, not prose — it stays, untranslated.
    const supported = screen.getByTestId("health-step-PORT_SUPPORTED");
    expect(within(supported).getByText("VID=1A86, PID=7523")).toBeInTheDocument();

    expect(screen.queryByText(/Handshake timed out/)).toBeNull();
    expect(screen.queryByText(/non-LumaSync firmware/)).toBeNull();
    expect(screen.queryByText(/serial inventory/)).toBeNull();
    // The banner's one-line summary names the failure in Turkish too.
    expect(screen.getAllByText(codes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.label)).toHaveLength(2);
    // The live region announces that summary; the step list sits outside it,
    // or every check would read a dozen nodes aloud.
    const status = screen.getByTestId("usb-status");
    expect(within(status).getByText(codes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.label)).toBeInTheDocument();
    expect(status).not.toContainElement(handshake);
  });

  it("names a worker panic, which replaces the whole step list", async () => {
    healthCheck = {
      pass: false,
      checkedAtUnixMs: 0,
      roundTripMs: null,
      firmwareVersion: null,
      advertisedFirmwareProfile: null,
      steps: [
        {
          step: "HEALTH_CHECK_WORKER",
          pass: false,
          code: "SERIAL_HEALTH_WORKER_PANIC",
          message: "Health check worker terminated unexpectedly.",
          details: "task 12 panicked",
        },
      ],
    };

    await runHealthCheck();

    const worker = await screen.findByTestId("health-step-HEALTH_CHECK_WORKER");
    expect(within(worker).getByText(codes.SERIAL_HEALTH_WORKER_PANIC.label)).toBeInTheDocument();
    expect(within(worker).getByText("task 12 panicked")).toBeInTheDocument();
    expect(screen.queryByText(/terminated unexpectedly/)).toBeNull();
  });

  it("falls back to Rust's message for a code the catalogue does not know", async () => {
    healthCheck = {
      pass: false,
      checkedAtUnixMs: 0,
      roundTripMs: null,
      firmwareVersion: null,
      advertisedFirmwareProfile: null,
      steps: rustSteps({
        step: "HANDSHAKE",
        pass: false,
        code: "SERIAL_HEALTH_SOMETHING_NEW" as HealthStepResult["code"],
        message: "A future failure mode.",
        details: "raw detail",
      }),
    };

    await runHealthCheck();

    const handshake = await screen.findByTestId("health-step-HANDSHAKE");
    expect(within(handshake).getByText("A future failure mode.")).toBeInTheDocument();
    expect(within(handshake).getByText("raw detail")).toBeInTheDocument();
  });
});
