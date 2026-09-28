import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadShellStateMock = vi.fn();
const readRegistryMock = vi.fn<() => Promise<LocalOutputsSnapshot | null>>();

const savedListeners = vi.hoisted(() => new Set<(saved: Record<string, unknown>) => void>());
vi.mock("../windowLifecycle", () => ({
  initWindowLifecycle: vi.fn(() => Promise.resolve()),
  loadShellState: () => loadShellStateMock(),
  onShellStateSaved: (listener: (saved: Record<string, unknown>) => void) => {
    savedListeners.add(listener);
    return () => savedListeners.delete(listener);
  },
}));
vi.mock("../useTrayIntegration", () => ({ pushTrayLabels: vi.fn() }));
vi.mock("@/features/platform/platformApi", () => ({ showNotification: vi.fn() }));
vi.mock("@/features/device/state/localOutputsStore", () => ({
  localOutputs: { refresh: () => readRegistryMock() },
}));

import { pushTrayLabels } from "../useTrayIntegration";
import { useShellBootstrap, type ShellBootstrapSink } from "../useShellBootstrap";
import type { LocalOutputsSnapshot } from "@/shared/contracts/device";

function registry(connected: "strip" | "wled" | "nothing"): LocalOutputsSnapshot {
  const strip = {
    kind: "serial",
    portName: "COM3",
    connected: connected === "strip",
    status: { code: connected === "strip" ? "CONNECT_OK" : "DISCONNECTED", message: "m", details: null },
    firmware: null,
    updatedAtUnixMs: 0,
  } as const;
  return {
    revision: 1,
    outputs: connected === "wled" ? [strip, { kind: "wled", ip: "192.168.1.42", ledCount: 60, connected: true }] : [strip],
    driven:
      connected === "strip"
        ? { kind: "serial", portName: "COM3" }
        : connected === "wled"
          ? { kind: "wled", ip: "192.168.1.42" }
          : null,
  };
}

function sink(overrides: Partial<ShellBootstrapSink> = {}): ShellBootstrapSink {
  return {
    t: ((key: string) => key) as unknown as ShellBootstrapSink["t"],
    setUIMode: vi.fn(),
    setActiveSection: vi.fn(),
    setSavedCalibration: vi.fn(),
    setHasCompletedOnboarding: vi.fn(),
    setOnboardingBootFacts: vi.fn<ShellBootstrapSink["setOnboardingBootFacts"]>(),
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
    readRegistryMock.mockResolvedValue(registry("strip"));
  });

  it("asks for the restore once, with the saved mode", async () => {
    const bag = sink();

    renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(bag.restoreLighting).toHaveBeenCalledTimes(1));
    expect(bag.restoreLighting).toHaveBeenCalledWith({
      lightingMode: { kind: "ambilight", ambilight: { brightness: 0.6 } },
    });
  });

  // The restore can wait seconds on a Hue start; the tray kept its English
  // labels and the shell its boot state for all of it.
  it("finishes the boot without waiting for the restore, which reports on its own", async () => {
    let finishRestore!: () => void;
    const restoreLighting = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve;
        }),
    );
    const bag = sink({ restoreLighting });

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    expect(pushTrayLabels).toHaveBeenCalledTimes(1);
    expect(result.current.lightingRestored).toBe(false);
    finishRestore();
    await waitFor(() => expect(result.current.lightingRestored).toBe(true));
  });

  // Off is asked too: the boot request is what tells Rust the saved choice,
  // so the tray's resume and the outputs shown are right from the first frame.
  it("asks for the restore with the mode off as well", async () => {
    loadShellStateMock.mockResolvedValue({ lightingMode: { kind: "off" } });
    const bag = sink();

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    expect(bag.restoreLighting).toHaveBeenCalledWith({ lightingMode: { kind: "off" } });
    // An Off choice is not lighting that ran, so the guide's last step still stands.
    expect(bag.setOnboardingBootFacts).toHaveBeenCalledWith({ outputRemembered: false, hasRunLighting: false });
  });

  it("tells the guide what is remembered and that a saved mode ran", async () => {
    loadShellStateMock.mockResolvedValue({
      lastSuccessfulPort: "COM3",
      lightingMode: { kind: "solid" },
    });
    const bag = sink();

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    expect(bag.setOnboardingBootFacts).toHaveBeenCalledWith({ outputRemembered: true, hasRunLighting: true });
  });

  it("arms the USB edge detector from the registry before the restore", async () => {
    readRegistryMock.mockResolvedValue(registry("nothing"));
    const bag = sink();

    renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(bag.restoreLighting).toHaveBeenCalled());
    expect(bag.armUsbConnected).toHaveBeenCalledWith({ serialConnected: false, localConnected: false });
    expect(
      (bag.armUsbConnected as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan((bag.restoreLighting as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it("arms a WLED device that took the strip's place as a local output, not a strip", async () => {
    readRegistryMock.mockResolvedValue(registry("wled"));
    const bag = sink();

    renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(bag.armUsbConnected).toHaveBeenCalled());
    expect(bag.armUsbConnected).toHaveBeenCalledWith({ serialConnected: false, localConnected: true });
  });

  it("arms as nothing connected when the registry could not be read", async () => {
    readRegistryMock.mockResolvedValue(null);
    const bag = sink();

    renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(bag.armUsbConnected).toHaveBeenCalled());
    expect(bag.armUsbConnected).toHaveBeenCalledWith({ serialConnected: false, localConnected: false });
  });

  it("still reports done when the restore throws, so the UI is not blocked", async () => {
    const bag = sink({ restoreLighting: vi.fn().mockRejectedValue(new Error("boom")) });

    const { result } = renderHook(() => useShellBootstrap(bag));

    await waitFor(() => expect(result.current.lightingRestored).toBe(true));
    expect(result.current.bootstrapDone).toBe(true);
  });

  it("runs once under StrictMode's double mount", async () => {
    const bag = sink();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

    const { result } = renderHook(() => useShellBootstrap(bag), { wrapper });

    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    expect(bag.restoreLighting).toHaveBeenCalledTimes(1);
    expect(loadShellStateMock).toHaveBeenCalledTimes(1);
  });

  // The lighting reads the primary strip's layout: a strip forgotten, or the primary laid out from
  // its own page, moves it, and the mode gate must not keep the one read at boot.
  it("follows the primary strip's layout when the strips are saved", async () => {
    const bag = sink();
    const { result } = renderHook(() => useShellBootstrap(bag));
    await waitFor(() => expect(result.current.bootstrapDone).toBe(true));
    vi.mocked(bag.setSavedCalibration).mockClear();

    for (const listener of savedListeners) listener({ lastSection: "devices" });
    expect(bag.setSavedCalibration).not.toHaveBeenCalled();

    for (const listener of savedListeners) listener({ ledStrips: [] });
    expect(bag.setSavedCalibration).toHaveBeenCalledWith(undefined);
  });
});
