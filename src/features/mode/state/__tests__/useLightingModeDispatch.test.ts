import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appliedResult } from "@/test/modeCommandResult";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../../model/contracts";
import { useLightingModeDispatch } from "../useLightingModeDispatch";

const setLightingModeMock = vi.fn();

vi.mock("../../modeApi", () => ({
  setLightingMode: (payload: LightingModeConfig) => setLightingModeMock(payload),
}));

const identity = (mode: LightingModeConfig) => mode;

const ambilight = (brightness: number): LightingModeConfig => ({
  kind: LIGHTING_MODE_KIND.AMBILIGHT,
  ambilight: { brightness },
});

describe("useLightingModeDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
      Promise.resolve(appliedResult(payload)),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips an identical payload — layer 1 content dedup (INV-6)", async () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await result.current.dispatch(ambilight(0.8));
    expect(setLightingModeMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    await result.current.dispatch(ambilight(0.8));
    expect(setLightingModeMock).toHaveBeenCalledOnce();
  });

  it("dedups across key insertion order, not just object identity", async () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await result.current.dispatch({ kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight: { brightness: 0.8, saturation: 1 } });
    vi.advanceTimersByTime(1_000);
    await result.current.dispatch({ ambilight: { saturation: 1, brightness: 0.8 }, kind: LIGHTING_MODE_KIND.AMBILIGHT });

    expect(setLightingModeMock).toHaveBeenCalledOnce();
  });

  it("skips a different payload inside the 20 ms cooldown — layer 2 (INV-6)", async () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await result.current.dispatch(ambilight(0.1));
    expect(setLightingModeMock).toHaveBeenCalledOnce();

    // Distinct content, but inside the temporal floor.
    await result.current.dispatch(ambilight(0.2));
    expect(setLightingModeMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(20);
    await result.current.dispatch(ambilight(0.3));
    expect(setLightingModeMock).toHaveBeenCalledTimes(2);
  });

  it("force bypasses both layers", async () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await result.current.dispatch(ambilight(0.8));
    await result.current.dispatch(ambilight(0.8), { force: true });
    expect(setLightingModeMock).toHaveBeenCalledTimes(2);
  });

  it("force still updates the signature and the cooldown clock (INV-7)", async () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await result.current.dispatch(ambilight(0.8), { force: true });
    expect(setLightingModeMock).toHaveBeenCalledOnce();

    // Signature was updated by the force → identical non-force fire is skipped.
    vi.advanceTimersByTime(1_000);
    await result.current.dispatch(ambilight(0.8));
    expect(setLightingModeMock).toHaveBeenCalledOnce();

    // Cooldown clock was updated too → a *different* payload 1 ms after a
    // force is still swallowed by the temporal floor.
    await result.current.dispatch(ambilight(0.9), { force: true });
    await result.current.dispatch(ambilight(0.4));
    expect(setLightingModeMock).toHaveBeenCalledTimes(2);
  });

  it("resetSignature lets an identical payload through again (INV-14)", async () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await result.current.dispatch(ambilight(0.8));
    vi.advanceTimersByTime(1_000);
    result.current.resetSignature();
    await result.current.dispatch(ambilight(0.8));

    expect(setLightingModeMock).toHaveBeenCalledTimes(2);
  });

  it("exposes a dispatchRef that is live from the first render (INV-8)", () => {
    const { result } = renderHook(() => useLightingModeDispatch(identity));
    expect(result.current.dispatchRef.current).toBe(result.current.dispatch);
  });

  it("dispatches the hydrated payload, not the caller's", async () => {
    const { result } = renderHook(() =>
      useLightingModeDispatch((mode) => ({ ...mode, displayId: "disp-9" })),
    );

    await result.current.dispatch({ kind: LIGHTING_MODE_KIND.OFF });
    expect(setLightingModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ displayId: "disp-9" }),
    );
  });

  it("propagates a backend rejection to the caller", async () => {
    setLightingModeMock.mockRejectedValue(new Error("USB gone"));
    const { result } = renderHook(() => useLightingModeDispatch(identity));

    await expect(result.current.dispatch(ambilight(0.8))).rejects.toThrow("USB gone");
  });
});
