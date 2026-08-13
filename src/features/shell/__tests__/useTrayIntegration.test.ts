import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/features/mode/model/contracts";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { useTrayIntegration, type TrayIntegrationInput } from "../useTrayIntegration";

type Listener = () => void;
const registered: Record<string, Listener | undefined> = {};
const unlisten = vi.fn();

vi.mock("@/features/tray/trayController", () => ({
  listenTrayLightsOff: (cb: Listener) => {
    registered.off = cb;
    return Promise.resolve(unlisten);
  },
  listenTrayResumeLastMode: (cb: Listener) => {
    registered.resume = cb;
    return Promise.resolve(unlisten);
  },
  listenTraySolidColor: (cb: Listener) => {
    registered.solid = cb;
    return Promise.resolve(unlisten);
  },
  listenTrayShowLedPreview: (cb: Listener) => {
    registered.preview = cb;
    return Promise.resolve(unlisten);
  },
  updateTrayLabels: () => Promise.resolve(),
}));

vi.mock("../windowLifecycle", () => ({
  loadShellState: () => Promise.resolve({}),
  saveShellState: () => Promise.resolve(),
}));

vi.mock("@/features/preview/previewApi", () => ({
  openLedControlPopup: () => Promise.resolve(),
  showLedControlPopup: () => Promise.resolve(),
  openLedTwinOverlay: () => Promise.resolve(),
}));

function harness(overrides: Partial<TrayIntegrationInput> = {}) {
  const onLightingModeChange = vi.fn().mockResolvedValue(undefined);
  const lightingModeRef = {
    current: { kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 1, g: 2, b: 3, brightness: 0.5 } },
  } as { current: LightingModeConfig };
  const lastNonOffModeRef = { current: null as LightingModeConfig | null };
  const selectedOutputTargetsRef = { current: ["usb"] as HueRuntimeTarget[] };

  const input: TrayIntegrationInput = {
    onLightingModeChange,
    lightingModeRef,
    lastNonOffModeRef,
    selectedOutputTargetsRef,
    getSelectedDisplayId: () => undefined,
    ...overrides,
  };

  const view = renderHook((props: TrayIntegrationInput) => useTrayIntegration(props), {
    initialProps: input,
  });
  return { view, input, onLightingModeChange, lightingModeRef, lastNonOffModeRef };
}

describe("useTrayIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(registered)) delete registered[key];
  });

  it("routes the tray Lights-Off action to the current handler", async () => {
    const { onLightingModeChange } = harness();
    await waitFor(() => expect(registered.off).toBeDefined());

    registered.off?.();
    expect(onLightingModeChange).toHaveBeenCalledWith({ kind: LIGHTING_MODE_KIND.OFF });
  });

  it("reaches the latest handler after a re-render, not the one captured at mount", async () => {
    const { view, input } = harness();
    await waitFor(() => expect(registered.off).toBeDefined());

    const nextHandler = vi.fn().mockResolvedValue(undefined);
    view.rerender({ ...input, onLightingModeChange: nextHandler });

    registered.off?.();
    expect(nextHandler).toHaveBeenCalledOnce();
    expect(input.onLightingModeChange).not.toHaveBeenCalled();
  });

  it("resumes the last non-off mode with the currently selected targets", async () => {
    const { onLightingModeChange, lastNonOffModeRef } = harness();
    await waitFor(() => expect(registered.resume).toBeDefined());
    lastNonOffModeRef.current = { kind: LIGHTING_MODE_KIND.AMBILIGHT };

    registered.resume?.();
    expect(onLightingModeChange).toHaveBeenCalledWith({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      targets: ["usb"],
    });
  });

  it("does not resume when the last known mode is off", async () => {
    const { onLightingModeChange, lightingModeRef } = harness();
    await waitFor(() => expect(registered.resume).toBeDefined());
    lightingModeRef.current = { kind: LIGHTING_MODE_KIND.OFF };

    registered.resume?.();
    expect(onLightingModeChange).not.toHaveBeenCalled();
  });

  it("falls back to white when the tray asks for Solid and no colour is set", async () => {
    const { onLightingModeChange, lightingModeRef } = harness();
    await waitFor(() => expect(registered.solid).toBeDefined());
    lightingModeRef.current = { kind: LIGHTING_MODE_KIND.OFF };

    registered.solid?.();
    expect(onLightingModeChange).toHaveBeenCalledWith({
      kind: LIGHTING_MODE_KIND.SOLID,
      solid: { r: 255, g: 255, b: 255, brightness: 1 },
      targets: ["usb"],
    });
  });

  it("removes every listener on unmount", async () => {
    const { view } = harness();
    await waitFor(() => expect(registered.preview).toBeDefined());

    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(4);
  });
});
