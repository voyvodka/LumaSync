import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEVICE_ERROR_CODES,
  SERIAL_CONNECT_STATUS,
  SERIAL_DISCONNECT_STATUS,
  type HealthCheckView,
  type LocalOutputsSnapshot,
} from "@/shared/contracts/device";
import type { ShellState } from "@/shared/contracts/shell";
import type { LedStrip } from "@/shared/contracts/strips";

import type { UseDeviceConnectionResult } from "../../useDeviceConnection";
import type { FlashOutcome } from "../../state/stripFlash";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const world = vi.hoisted(() => ({
  snapshot: { revision: 1, outputs: [], driven: null } as LocalOutputsSnapshot,
  flash: "lit" as FlashOutcome,
  stored: {} as Partial<ShellState>,
  updateFails: false,
}));

vi.mock("../../state/localOutputsStore", () => ({
  useLocalOutputs: <S,>(selector: (state: { snapshot: LocalOutputsSnapshot }) => S) =>
    selector({ snapshot: world.snapshot }),
}));

vi.mock("../../state/stripFlash", async (importActual) => {
  const actual = await importActual<typeof import("../../state/stripFlash")>();
  return { ...actual, flashStrip: vi.fn(async () => world.flash) };
});

const disconnectSerialPort = vi.hoisted(() => vi.fn<typeof import("../../deviceConnectionApi").disconnectSerialPort>());
vi.mock("../../deviceConnectionApi", () => ({ disconnectSerialPort }));

const ensure = vi.hoisted(() => vi.fn<(port: string, previous: string | null) => Promise<unknown[]>>(async () => []));
vi.mock("../../model/usbStripRoster", () => ({ ensureStripForPort: ensure }));

vi.mock("../../useAdvertisedFirmwareProfile", () => ({
  useAdvertisedFirmwareProfile: () => undefined,
  useAdvertisedPixelLayout: () => undefined,
}));

const update = vi.hoisted(() => vi.fn<(edit: (state: ShellState) => Partial<ShellState> | null) => Promise<ShellState>>());
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: async () => world.stored,
    update,
    onSaved: () => () => {},
  },
}));

import { markStripLit } from "../../state/stripFlash";
import { StripPage } from "../StripPage";

const PORT = "/dev/cu.usbserial-1420";

type Nav = () => Promise<void>;

const strip = (extra: Partial<LedStrip> = {}): LedStrip & { transport: { kind: "serial"; portName: string } } => ({
  id: "strip-1",
  enabled: true,
  transport: { kind: "serial", portName: PORT },
  hardware: {},
  ...extra,
} as LedStrip & { transport: { kind: "serial"; portName: string } });

const ok = { code: SERIAL_CONNECT_STATUS.OK, message: "ok" };

function registry(entry: "connected" | "released" | "gone" | "busy" | null) {
  world.snapshot = {
    revision: world.snapshot.revision + 1,
    outputs:
      entry === null
        ? []
        : [
            {
              kind: "serial",
              portName: PORT,
              connected: entry === "connected",
              status:
                entry === "gone"
                  ? { code: DEVICE_ERROR_CODES.PORT_NOT_FOUND, message: "gone" }
                  : entry === "busy"
                    ? { code: SERIAL_CONNECT_STATUS.IO_ERROR, message: "busy" }
                    : ok,
              firmware: null,
              updatedAtUnixMs: 0,
            },
          ],
    driven: entry === "connected" ? { kind: "serial", portName: PORT } : null,
  } as LocalOutputsSnapshot;
}

function device(overrides: Partial<UseDeviceConnectionResult> = {}): UseDeviceConnectionResult {
  return {
    status: "idle",
    ports: [{ portName: PORT, product: "CH340 USB Serial", isSupported: true } as UseDeviceConnectionResult["ports"][number]],
    selectedPort: null,
    connectedPort: null,
    statusCard: null,
    canConnect: true,
    isScanning: false,
    isConnecting: false,
    isReconnecting: false,
    isHealthChecking: false,
    activeOperation: "idle" as UseDeviceConnectionResult["activeOperation"],
    latestHealthCheck: null,
    isConnected: false,
    refreshPorts: vi.fn<Nav>(async () => {}),
    selectPort: vi.fn<UseDeviceConnectionResult["selectPort"]>(),
    connectSelectedPort: vi.fn<UseDeviceConnectionResult["connectSelectedPort"]>(async () => true),
    runHealthCheck: vi.fn<Nav>(async () => {}),
    ...overrides,
  };
}

async function renderPage(
  props: {
    strip?: ReturnType<typeof strip>;
    device?: UseDeviceConnectionResult;
    onNavigateToLedSetup?: () => void;
    autoFlash?: boolean;
    onAutoFlashDone?: () => void;
  } = {},
) {
  const view = render(
    <StripPage
      isActive
      strip={props.strip ?? strip()}
      name="USB strip"
      device={props.device ?? device()}
      onNavigateToLedSetup={props.onNavigateToLedSetup ?? (() => {})}
      onNavigateToRoomMap={() => {}}
      autoFlash={props.autoFlash}
      onAutoFlashDone={props.onAutoFlashDone}
    />,
  );
  // The page reads the store on mount; settling it here keeps that update inside act.
  await act(async () => {});
  return view;
}

const isPrimary = (element: HTMLElement) => /primary/.test(element.className);

beforeEach(() => {
  world.flash = "lit";
  world.stored = {};
  update.mockReset();
  update.mockImplementation(async (edit: (state: ShellState) => Partial<ShellState> | null) => {
    edit({ ledStrips: [strip()] } as unknown as ShellState);
    return {} as ShellState;
  });
  disconnectSerialPort.mockReset();
  markStripLit("strip-1", true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("StripPage — the strip's state and its one action", () => {
  it("a strip not connected says so and offers Connect as the page's amber", async () => {
    registry("released");
    const dev = device();
    await renderPage({ device: dev });

    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.disconnected");
    const connect = screen.getByTestId("strip-connect");
    expect(isPrimary(connect)).toBe(true);
    // One amber at rest: a strip with no layout waits behind the connect.
    expect(isPrimary(screen.getByTestId("strip-layout-open"))).toBe(false);

    fireEvent.click(connect);
    expect(dev.selectPort).toHaveBeenCalledWith(PORT);
    expect(dev.connectSelectedPort).toHaveBeenCalledTimes(1);
  });

  it("a connected strip with no layout makes Set up the amber, and it opens LED Setup", async () => {
    registry("connected");
    const onNavigateToLedSetup = vi.fn<() => void>();
    await renderPage({ onNavigateToLedSetup });

    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.connected");
    expect(isPrimary(screen.getByTestId("strip-flash"))).toBe(false);
    const setUp = screen.getByTestId("strip-layout-open");
    expect(isPrimary(setUp)).toBe(true);
    expect(setUp).toHaveTextContent("device:strip.action.setUp");
    fireEvent.click(setUp);
    expect(onNavigateToLedSetup).toHaveBeenCalledTimes(1);
  });

  it("a strip with a layout reads its size and offers Edit", async () => {
    registry("connected");
    await renderPage({
      strip: strip({
        layout: {
          counts: { top: 30, right: 20, bottom: 0, left: 20 },
          bottomMissing: 0,
          cornerOwnership: "horizontal",
          visualPreset: "subtle",
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 70,
        },
      }),
    });
    expect(screen.getByTestId("strip-layout")).toHaveTextContent("device:strip.layoutValue");
    expect(screen.getByTestId("strip-layout-open")).toHaveTextContent("device:strip.action.edit");
  });

  it("a port that went away waits for it, with nothing to press", async () => {
    registry("gone");
    await renderPage();
    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.reconnecting");
    expect(screen.queryByTestId("strip-connect")).toBeNull();
    expect(screen.queryByTestId("strip-flash")).toBeNull();
  });

  it("a port another app holds reads as busy and offers Try again", async () => {
    registry("busy");
    await renderPage();
    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.busy");
    expect(screen.getByTestId("strip-connect")).toHaveTextContent("device:strip.action.retry");
  });

  it("a failed connect of this port is told under the row, in the user's words", async () => {
    registry("busy");
    await renderPage({
      device: device({
        selectedPort: PORT,
        statusCard: { variant: "error", code: SERIAL_CONNECT_STATUS.IO_ERROR, message: "Resource busy", details: "os error 16" },
      }),
    });
    const note = screen.getByTestId("strip-connect-error");
    expect(note).toHaveTextContent("device:healthCheck.serialHealthCodes.CONNECT_IO_ERROR.label");
    // What to do, the OS's own words and the code sit behind one ⓘ.
    expect(note).not.toHaveTextContent("os error 16");
    fireEvent.click(within(note).getByRole("button", { name: "device:strip.codeTip" }));
    const tip = await screen.findByRole("dialog", { name: "device:strip.codeTip" });
    expect(tip).toHaveTextContent("os error 16");
    expect(tip).toHaveTextContent("device:healthCheck.serialHealthCodes.CONNECT_IO_ERROR.hint");
    expect(within(tip).getByTestId("strip-fault-code")).toHaveTextContent(SERIAL_CONNECT_STATUS.IO_ERROR);
  });

  it("a retry that fails at once still reads Connecting for a moment, and the note stays put", async () => {
    registry("released");
    const failed = device({
      selectedPort: PORT,
      statusCard: { variant: "error", code: SERIAL_CONNECT_STATUS.IO_ERROR, message: "busy" },
    });
    const view = await renderPage({ device: failed });
    const rerender = (next: UseDeviceConnectionResult) =>
      view.rerender(
        <StripPage isActive strip={strip()} name="USB strip" device={next} onNavigateToLedSetup={() => {}} onNavigateToRoomMap={() => {}} />,
      );

    rerender(device({ selectedPort: PORT, isConnecting: true }));
    expect(screen.getByTestId("strip-connect-error")).toBeInTheDocument();
    rerender(failed);
    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.connecting");
    expect(screen.getByTestId("strip-connect-error")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.disconnected"));
    expect(screen.getByTestId("strip-connect-error")).toBeInTheDocument();
  });

  // At launch nobody pressed anything: the reason comes from what Rust recorded for the port.
  it("a port held elsewhere at rest says why, with the code behind ⓘ", async () => {
    registry("busy");
    await renderPage();
    expect(screen.getByTestId("strip-connect-error")).toHaveTextContent(
      "device:healthCheck.serialHealthCodes.CONNECT_IO_ERROR.label",
    );
  });

  it("a strip let go of is not a failure", async () => {
    registry("released");
    await renderPage();
    expect(screen.queryByTestId("strip-connect-error")).toBeNull();
  });

  it("a failed connect of another port stays off this page", async () => {
    registry("released");
    await renderPage({
      device: device({
        selectedPort: "/dev/cu.other",
        statusCard: { variant: "error", code: SERIAL_CONNECT_STATUS.IO_ERROR, message: "busy" },
      }),
    });
    expect(screen.queryByTestId("strip-connect-error")).toBeNull();
  });
});

describe("StripPage — flash and ask", () => {
  it("No turns the strip into Didn't light with what to check; Yes clears it", async () => {
    registry("connected");
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-flash"));
    await screen.findByTestId("strip-flash-question");
    fireEvent.click(screen.getByTestId("strip-flash-no"));

    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.unlit");
    expect(screen.getByTestId("strip-unlit-help")).toHaveTextContent("device:strip.flash.help.ground");
    // The page swap keeps the leaving face for its exit, hidden from assistive tech.
    const retry = screen.getByRole("button", { name: "device:strip.action.retry" });
    expect(retry).toHaveAttribute("data-testid", "strip-flash");
    expect(isPrimary(retry)).toBe(true);
    // The retry is the amber now; the layout waits.
    expect(isPrimary(screen.getByTestId("strip-layout-open"))).toBe(false);

    fireEvent.click(retry);
    await screen.findByTestId("strip-flash-question");
    fireEvent.click(screen.getByTestId("strip-flash-yes"));
    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.connected");
  });

  it("a flash that reached only the preview says so instead of asking", async () => {
    registry("connected");
    world.flash = "notSent";
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-flash"));
    expect(await screen.findByTestId("strip-flash-problem")).toHaveTextContent("device:strip.flash.notSent");
    expect(screen.queryByTestId("strip-flash-question")).toBeNull();
  });
});

describe("StripPage — the menu", () => {
  it("Disconnect lets go of this port; a refusal is told", async () => {
    registry("connected");
    disconnectSerialPort.mockResolvedValue({
      portName: PORT,
      status: { code: SERIAL_DISCONNECT_STATUS.FAILED, message: "held", details: null },
    });
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-more"));
    fireEvent.click(await screen.findByRole("button", { name: "device:strip.action.disconnect" }));
    await waitFor(() => expect(disconnectSerialPort).toHaveBeenCalledWith(PORT));
    expect(await screen.findByText("device:strip.disconnectFailed")).toBeInTheDocument();
  });

  it("a strip not connected has nothing to disconnect", async () => {
    registry("released");
    await renderPage();
    fireEvent.click(screen.getByTestId("strip-more"));
    expect(await screen.findByRole("button", { name: "device:strip.action.openInMap" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "device:strip.action.disconnect" })).toBeNull();
  });
});

describe("StripPage — name", () => {
  it("the pencil opens an empty field; Enter keeps what was typed on this strip", async () => {
    registry("connected");
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-rename"));
    const input = screen.getByTestId("strip-name-input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("USB strip");
    fireEvent.change(input, { target: { value: "  Desk  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const edit = update.mock.calls[0]![0] as (state: ShellState) => Partial<ShellState> | null;
    expect(edit({ ledStrips: [strip()] } as unknown as ShellState)?.ledStrips?.[0]?.name).toBe("Desk");
    expect(screen.queryByTestId("strip-name-input")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("USB strip");
  });

  it("Esc puts the name back and saves nothing", async () => {
    registry("connected");
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-rename"));
    const input = screen.getByTestId("strip-name-input");
    fireEvent.change(input, { target: { value: "Desk" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByTestId("strip-name-input")).toBeNull();
  });
});

describe("StripPage — hardware", () => {
  it("a chip change is saved on this strip by id", async () => {
    registry("connected");
    await renderPage({ strip: strip({ id: "strip-2" }) });

    fireEvent.click(screen.getByTestId("strip-chip-sk6812-rgbw"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const edit = update.mock.calls[0]![0] as (state: ShellState) => Partial<ShellState> | null;
    const saved = edit({ ledStrips: [strip(), strip({ id: "strip-2" })] } as unknown as ShellState);
    expect(saved?.ledStrips?.[0]?.hardware).toEqual({});
    expect(saved?.ledStrips?.[1]?.hardware).toEqual({ chipType: "sk6812-rgbw" });
  });

  it("a save that fails is told, not swallowed", async () => {
    registry("connected");
    update.mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-chip-sk6812-rgbw"));
    expect(await screen.findByTestId("strip-hardware-failed")).toBeInTheDocument();
  });
});

describe("StripPage — health", () => {
  const failed: HealthCheckView = {
    pass: false,
    checkedAtUnixMs: 0,
    steps: [
      { step: "PORT_VISIBLE", pass: true, code: "PORT_VISIBLE", message: "", details: null },
      { step: "CONNECT_AND_VERIFY", pass: false, code: "SERIAL_HEALTH_HANDSHAKE_TIMEOUT", message: "timeout", details: null },
    ],
  } as unknown as HealthCheckView;

  it("never run reads so, and Check runs it on this port", async () => {
    registry("connected");
    const dev = device();
    await renderPage({ device: dev });

    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.never");
    fireEvent.click(screen.getByTestId("strip-health-run"));
    expect(dev.selectPort).toHaveBeenCalledWith(PORT);
    expect(dev.runHealthCheck).toHaveBeenCalledTimes(1);
  });

  it("a failed check names the failing step and says what to do", async () => {
    registry("connected");
    await renderPage({ device: device({ latestHealthCheck: failed }) });
    fireEvent.click(screen.getByTestId("strip-health-run"));

    expect(screen.getByTestId("strip-health-value")).toHaveTextContent(
      "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.label",
    );
    expect(within(screen.getByTestId("strip-health-failed")).getByText(
      "device:healthCheck.serialHealthCodes.SERIAL_HEALTH_HANDSHAKE_TIMEOUT.hint",
    )).toBeInTheDocument();
  });

  it("a strip not connected offers no check, only its value", async () => {
    registry("released");
    await renderPage();
    expect(screen.queryByTestId("strip-health-run")).toBeNull();
    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.never");
  });

  it("the check's busy label holds the button's place", async () => {
    registry("connected");
    const dev = device();
    dev.runHealthCheck = vi.fn<UseDeviceConnectionResult["runHealthCheck"]>(async () => {
      dev.isHealthChecking = true;
    });
    await renderPage({ device: dev });
    fireEvent.click(screen.getByTestId("strip-health-run"));
    expect(screen.getByTestId("strip-health-run")).toHaveAttribute("aria-busy", "true");
  });

  // One result is kept for whichever port was checked; the strip keeps its page when it moves.
  it("a result from another port is not shown, even on this strip's page", async () => {
    registry("connected");
    const passed = { ...failed, pass: true, steps: [] } as unknown as HealthCheckView;
    const dev = device({ latestHealthCheck: passed });
    const view = await renderPage({ device: dev });
    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.never");

    fireEvent.click(screen.getByTestId("strip-health-run"));
    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.passed");

    // The strip moves to another controller: the pass was the old one's.
    view.rerender(
      <StripPage
        isActive
        strip={strip({ transport: { kind: "serial", portName: "/dev/cu.other" } })}
        name="USB strip"
        device={dev}
      />,
    );
    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.never");
  });
});

describe("StripPage — opening", () => {
  it("opens on the strip's stored hardware, with nothing arriving late", async () => {
    registry("connected");
    await renderPage({ strip: strip({ hardware: { chipType: "sk6812-rgbw", colorOrder: "grb" } }) });
    expect(screen.getByTestId("strip-chip-sk6812-rgbw")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("strip-color-order-value")).toHaveTextContent("GRB");
    await act(async () => {});
    expect(screen.getByTestId("strip-chip-sk6812-rgbw")).toHaveAttribute("aria-checked", "true");
  });
});

describe("StripPage — after adding", () => {
  it("a strip just added flashes and asks on its own, once connected", async () => {
    registry("connected");
    const onAutoFlashDone = vi.fn<() => void>();
    await renderPage({ autoFlash: true, onAutoFlashDone });
    expect(await screen.findByTestId("strip-flash-question")).toBeInTheDocument();
    expect(onAutoFlashDone).toHaveBeenCalledTimes(1);
  });

  it("waits while the strip is still connecting", async () => {
    registry("released");
    const onAutoFlashDone = vi.fn<() => void>();
    await renderPage({ autoFlash: true, onAutoFlashDone, device: device({ isConnecting: true, selectedPort: PORT }) });
    await act(async () => {});
    expect(onAutoFlashDone).not.toHaveBeenCalled();
    expect(screen.queryByTestId("strip-flash-question")).toBeNull();
  });
});

describe("StripPage — the room map", () => {
  it("offers a connected strip the room map lacks, and places it on its own port", async () => {
    registry("connected");
    world.stored = { roomMap: { usbStrips: [] } } as unknown as Partial<ShellState>;
    await renderPage();

    fireEvent.click(screen.getByTestId("strip-more"));
    fireEvent.click(await screen.findByRole("button", { name: "device:strip.action.addToMap" }));
    await waitFor(() => expect(ensure).toHaveBeenCalledWith(PORT, PORT));
  });

  it("offers nothing when a placement already names the port", async () => {
    registry("connected");
    world.stored = { roomMap: { usbStrips: [{ stripId: "a", portName: PORT }] } } as unknown as Partial<ShellState>;
    await renderPage();
    await act(async () => {});

    fireEvent.click(screen.getByTestId("strip-more"));
    await screen.findByRole("button", { name: "device:strip.action.openInMap" });
    expect(screen.queryByRole("button", { name: "device:strip.action.addToMap" })).toBeNull();
  });
});

describe("StripPage — forget", () => {
  async function askToForget() {
    fireEvent.click(screen.getByTestId("strip-more"));
    fireEvent.click(await screen.findByRole("button", { name: "device:strip.action.forget" }));
    fireEvent.click(await screen.findByTestId("strip-forget-confirm-yes"));
  }

  it("lets go of the port first, then drops this strip only", async () => {
    registry("connected");
    disconnectSerialPort.mockResolvedValue({
      portName: PORT,
      status: { code: SERIAL_DISCONNECT_STATUS.OK, message: "", details: null },
    });
    await renderPage();
    await askToForget();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(disconnectSerialPort).toHaveBeenCalledWith(PORT);
    const edit = update.mock.calls[0]![0] as (state: ShellState) => Partial<ShellState> | null;
    const kept = edit({ ledStrips: [strip(), strip({ id: "strip-2" })] } as unknown as ShellState);
    expect(kept?.ledStrips?.map((each) => each.id)).toEqual(["strip-2"]);
  });

  // A strip still driving must not lose its record.
  it("a refused disconnect forgets nothing and says so", async () => {
    registry("connected");
    disconnectSerialPort.mockResolvedValue({
      portName: PORT,
      status: { code: SERIAL_DISCONNECT_STATUS.FAILED, message: "held", details: null },
    });
    await renderPage();
    await askToForget();

    expect(await screen.findByText("device:strip.disconnectFailed")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("a strip not connected is forgotten without a disconnect", async () => {
    registry("released");
    await renderPage();
    await askToForget();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(disconnectSerialPort).not.toHaveBeenCalled();
  });
});

