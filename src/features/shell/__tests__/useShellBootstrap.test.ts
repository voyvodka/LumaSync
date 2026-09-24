import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadShellStateMock = vi.fn();
const getSerialConnectionStatusMock = vi.fn<typeof deviceConnectionApiModule.getSerialConnectionStatus>();

vi.mock("../windowLifecycle", () => ({
  initWindowLifecycle: vi.fn(() => Promise.resolve()),
  loadShellState: () => loadShellStateMock(),
}));
vi.mock("../useTrayIntegration", () => ({ pushTrayLabels: vi.fn() }));
vi.mock("@/features/platform/platformApi", () => ({ showNotification: vi.fn() }));
vi.mock("@/features/device/deviceConnectionApi", () => ({
  getSerialConnectionStatus: () => getSerialConnectionStatusMock(),
}));

import { useShellBootstrap, type ShellBootstrapSink } from "../useShellBootstrap";
import type * as deviceConnectionApiModule from "@/features/device/deviceConnectionApi";
import type { SerialConnectionStatus } from "@/shared/contracts/device";

function connectionStatus(connected: boolean): SerialConnectionStatus {
  return {
    portName: connected ? "COM3" : null,
    connected,
    status: connected
      ? { code: "CONNECT_OK", message: "Connected", details: null }
      : { code: "NOT_CONNECTED", message: "Not connected", details: null },
    updatedAtUnixMs: 0,
  };
}

function sink(overrides: Partial<ShellBootstrapSink> = {}): ShellBootstrapSink {
  return {
    t: ((key: string) => key) as unknown as ShellBootstrapSink["t"],
    setUIMode: vi.fn(),
    setActiveSection: vi.fn(),
    setSavedCalibration: vi.fn(),
    setHasCompletedOnboarding: vi.fn(),
    setHasInteractedWithMode: vi.fn(),
    setHueStartConfig: vi.fn(),
    armUsbConnected: vi.fn(),
    restoreLighting: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * The launch restore is the Rust transaction's (`origin: "boot"`): it reads the
 * saved mode and outputs itself, keeps a strip that is not there yet selected,
 * and waits out a held Hue area once. What is left here is the order of the
 * boot spine around it. docs/architecture/lighting-transaction.md.
 */
describe("useShellBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadShellStateMock.mockResolvedValue({
      uiMode: "compact",
      lightingMode: { kind: "ambilight", ambilight: { brightness: 0.6 } },
      lastOutputTargets: ["usb", "hue"],
    });
    getSerialConnectionStatusMock.mockResolvedValue(connectionStatus(true));
  });

  it("asks for the restore once, with the saved mode, before it reports done", async () => {
    let finishRestore!: () => void;
    const restoreLighting = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve;
        }),
    );
    const bag = sink({ restoreLighting });

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(restoreLighting).toHaveBeenCalledTimes(1));
    expect(restoreLighting).toHaveBeenCalledWith({
      lightingMode: { kind: "ambilight", ambilight: { brightness: 0.6 } },
    });
    expect(result.current.bootstrapDone).toBe(false);
    finishRestore();
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
  });

  // Off is asked too: the boot request is what tells Rust the saved choice,
  // so the tray's resume and the outputs shown are right from the first frame.
  it("asks for the restore with the mode off as well", async () => {
    loadShellStateMock.mockResolvedValue({ lightingMode: { kind: "off" } });
    const bag = sink();

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    expect(bag.restoreLighting).toHaveBeenCalledWith({ lightingMode: { kind: "off" } });
    expect(bag.setHasInteractedWithMode).toHaveBeenCalledWith(true);
  });

  it("arms the USB edge detector from the live status before the restore", async () => {
    getSerialConnectionStatusMock.mockResolvedValue(connectionStatus(false));
    const bag = sink();

    renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(bag.restoreLighting).toHaveBeenCalled());
    expect(bag.armUsbConnected).toHaveBeenCalledWith(false);
    expect(
      (bag.armUsbConnected as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan((bag.restoreLighting as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it("still reports done when the restore throws, so the UI is not blocked", async () => {
    const bag = sink({ restoreLighting: vi.fn().mockRejectedValue(new Error("boom")) });

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
  });

  it("runs once under StrictMode's double mount", async () => {
    const bag = sink();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

    const { result } = renderHook(() => useShellBootstrap(bag), { wrapper });

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    expect(bag.restoreLighting).toHaveBeenCalledTimes(1);
    expect(loadShellStateMock).toHaveBeenCalledTimes(1);
  });
});
