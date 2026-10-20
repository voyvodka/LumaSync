import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WLED_STATUS, type WledCommandStatus, type WledDeviceInfo } from "@/shared/contracts/device";
import type { LedStrip } from "@/shared/contracts/strips";

import type { WledRestoreOutcome } from "../../wledSinkRestore";
import type { WledConnectDeps } from "../../state/useWledConnect";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  // The colour row reads the store; it is not what these tests are about, so its read never lands.
  shellStore: { update: async () => ({}), load: () => new Promise(() => {}), onSaved: () => () => undefined },
}));
vi.mock("../../state/stripFlash", async (importActual) => ({
  ...(await importActual<typeof import("../../state/stripFlash")>()),
  flashStrip: async () => "lit" as const,
}));

import { markStripLit } from "../../state/stripFlash";
import { WledStripPage, type WledStripPageProps } from "../WledStripPage";

const IP = "192.168.1.42";
const DEVICE: WledDeviceInfo = { ip: IP, ledCount: 120, name: "Panel" };
const ok = (code: string): WledCommandStatus => ({ code, message: "", details: null }) as WledCommandStatus;

const strip = {
  id: "strip-2",
  enabled: true,
  transport: { kind: "wled", sink: { ip: IP, port: 4048, ledCount: 120, protocol: "ddp" } },
  hardware: {},
} as LedStrip as WledStripPageProps["strip"];

function wled(overrides: Partial<WledStripPageProps["wled"]> = {}): WledStripPageProps["wled"] {
  return {
    activeWledIp: null,
    restoreOutcome: { kind: "idle" },
    markConnected: vi.fn<(device: WledDeviceInfo) => Promise<void>>(async () => {}),
    forget: vi.fn<(ip: string) => Promise<WledCommandStatus>>(async () => ok(WLED_STATUS.FORGET_OK)),
    ...overrides,
  };
}

function connectDeps(discovered: WledCommandStatus, bound = ok(WLED_STATUS.CONNECT_OK)): Required<WledConnectDeps> {
  return {
    discover: vi.fn<NonNullable<WledConnectDeps["discover"]>>(async () => ({
      status: discovered,
      devices: discovered.code === WLED_STATUS.DISCOVERY_OK ? [DEVICE] : [],
    })),
    connect: vi.fn<NonNullable<WledConnectDeps["connect"]>>(async () => ({ status: bound })),
  };
}

function renderPage(props: Partial<WledStripPageProps> = {}) {
  return render(<WledStripPage isActive strip={strip} name="WLED 192.168.1.42" wled={wled()} {...props} />);
}

beforeEach(() => {
  markStripLit("strip-2", true);
});

describe("WledStripPage", () => {
  it("a bound device reads Connected, with the LED count it reported", () => {
    renderPage({ wled: wled({ activeWledIp: IP }) });
    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.connected");
    expect(screen.getByTestId("strip-flash")).toBeInTheDocument();
    expect(screen.getByTestId("strip-led-count")).toHaveTextContent("device:strip.ledCountValue");
    // WLED owns its chip and order: no hardware rows.
    expect(screen.queryByTestId("strip-chip")).toBeNull();
    expect(screen.queryByTestId("strip-color-order")).toBeNull();
  });

  it("Connect asks the device what it is, binds it and records it", async () => {
    const deps = connectDeps(ok(WLED_STATUS.DISCOVERY_OK));
    const sink = wled();
    renderPage({ wled: sink, connectDeps: deps });

    expect(screen.getByTestId("strip-state")).toHaveTextContent("device:strip.state.disconnected");
    fireEvent.click(screen.getByTestId("strip-connect"));

    await waitFor(() => expect(sink.markConnected).toHaveBeenCalledWith(DEVICE));
    expect(deps.discover).toHaveBeenCalledWith(IP);
    expect(deps.connect).toHaveBeenCalledWith(DEVICE);
  });

  it("a device that does not answer is told, and nothing is recorded", async () => {
    const deps = connectDeps(ok(WLED_STATUS.DISCOVERY_TIMEOUT));
    const sink = wled();
    renderPage({ wled: sink, connectDeps: deps });

    fireEvent.click(screen.getByTestId("strip-connect"));
    expect(await screen.findByTestId("wled-connect-failed")).toHaveTextContent("device:page.wled.status.discoveryTimeout");
    expect(deps.connect).not.toHaveBeenCalled();
    expect(sink.markConnected).not.toHaveBeenCalled();
  });

  it("a launch reconnect that failed is said until the page tries again", () => {
    const restoreOutcome: WledRestoreOutcome = {
      kind: "failed",
      sink: strip.transport.sink,
      status: ok(WLED_STATUS.BRIDGE_UNREACHABLE),
    };
    renderPage({ wled: wled({ restoreOutcome }) });
    const note = screen.getByTestId("wled-connect-failed");
    expect(note).toHaveTextContent("device:page.wled.restore.failed");
    expect(note).toHaveTextContent("device:page.wled.status.bridgeUnreachable");
  });

  it("Forget asks first, beside the menu, and a refusal is told", async () => {
    const sink = wled({
      activeWledIp: IP,
      forget: vi.fn<(ip: string) => Promise<WledCommandStatus>>(async () => ok(WLED_STATUS.FORGET_FAILED)),
    });
    renderPage({ wled: sink });

    fireEvent.click(screen.getByTestId("strip-more"));
    fireEvent.click(await screen.findByRole("button", { name: "device:strip.action.forget" }));
    expect(sink.forget).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("wled-forget-confirm-yes"));

    await waitFor(() => expect(sink.forget).toHaveBeenCalledWith(IP));
    expect(await screen.findByTestId("wled-forget-failed")).toBeInTheDocument();
  });

  it("a strip just added flashes and asks on its own", async () => {
    const onAutoFlashDone = vi.fn<() => void>();
    renderPage({ wled: wled({ activeWledIp: IP }), autoFlash: true, onAutoFlashDone });
    expect(await screen.findByTestId("strip-flash-question")).toBeInTheDocument();
    expect(onAutoFlashDone).toHaveBeenCalledTimes(1);
  });

  it("Check sends one test frame to the bound device and says what it found", async () => {
    const checkBridge = vi.fn<NonNullable<WledStripPageProps["checkBridge"]>>(async () => ({
      status: ok(WLED_STATUS.REALTIME_PORT_MISMATCH),
    }));
    renderPage({ wled: wled({ activeWledIp: IP }), checkBridge });

    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.never");
    fireEvent.click(screen.getByTestId("strip-health-run"));

    await waitFor(() => expect(checkBridge).toHaveBeenCalledWith({ ip: IP, ledCount: 120 }));
    expect(await screen.findByTestId("strip-health-failed")).toHaveTextContent(
      "device:page.wled.status.realtimePortMismatch",
    );
    expect(screen.getByTestId("strip-health-value")).toHaveTextContent("device:strip.health.problem");
  });

  it("a device not bound offers no check: the test needs the sink running", () => {
    renderPage();
    expect(screen.queryByTestId("strip-health-run")).toBeNull();
  });

  it("Forget is the last thing in the menu, as on the Hue page", async () => {
    renderPage({ wled: wled({ activeWledIp: IP }), onNavigateToRoomMap: () => {} });
    fireEvent.click(screen.getByTestId("strip-more"));
    await screen.findByRole("button", { name: "device:strip.action.forget" });
    const items = screen.getAllByRole("button").filter((button) => button.closest("[role=dialog]") !== null);
    expect(items[items.length - 1]).toHaveAccessibleName("device:strip.action.forget");
  });
});

