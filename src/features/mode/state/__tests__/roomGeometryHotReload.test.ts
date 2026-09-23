// Room geometry hot reload through the real hook stack — runtime config,
// orchestrator, hot-reload handlers, the save listener and the shell store —
// with only the Tauri boundary (`invoke`, plugin-store) mocked.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveShellState } from "@/features/shell/windowLifecycle";
import { CAPTURE_COMMANDS } from "@/shared/contracts/capture";
import { DEVICE_COMMANDS } from "@/shared/contracts/device";
import { HUE_COMMANDS } from "@/shared/contracts/hue";
import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { SHELL_STATE_SCHEMA_VERSION, SHELL_STORE_KEY } from "@/shared/contracts/shell";
import { appliedResult } from "@/test/modeCommandResult";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/shared/contracts/mode";
import { useLightingModeOrchestrator } from "../useLightingModeOrchestrator";
import { useModeHotReload } from "../useModeHotReload";
import { useModeRuntimeConfig } from "../useModeRuntimeConfig";
import { ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS, useRoomGeometrySync } from "../useRoomGeometrySync";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

let storeBlob: Record<string, unknown> = {};
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    Promise.resolve({
      get: (key: string) => Promise.resolve(key === SHELL_STORE_KEY ? storeBlob : undefined),
      set: (key: string, value: Record<string, unknown>) => {
        if (key === SHELL_STORE_KEY) storeBlob = value;
        return Promise.resolve();
      },
    }),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

function roomMap(lampX: number, tv = true): RoomMapConfig {
  return {
    ...DEFAULT_ROOM_MAP,
    hueChannels: [
      { channelIndex: 0, channelId: 3, x: lampX, y: 0.8, z: 0.5, zOrigin: "user", entertainmentAreaId: "area-1" },
    ],
    ...(tv ? { tvAnchor: { x: 1.5, y: 0, width: 2, height: 0.3, locked: true } } : {}),
  };
}

function geometryWithLampAt(lampX: number) {
  return {
    dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
    tv: { x: 1.5, y: 0, width: 2, height: 0.3 },
    huePlacements: [{ channelId: 3, positionX: lampX, positionY: 0.8, positionZ: 0.5 }],
  };
}

function lightingCalls(): LightingModeConfig[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === DEVICE_COMMANDS.SET_LIGHTING_MODE)
    .map(([, args]) => (args as { payload: LightingModeConfig }).payload);
}

function hueStreamCalls() {
  const hueCommands: string[] = [
    HUE_COMMANDS.START_STREAM,
    HUE_COMMANDS.STOP_STREAM,
    HUE_COMMANDS.RESTART_STREAM,
  ];
  return invokeMock.mock.calls.filter(([command]) => hueCommands.includes(command as string));
}

function useStack() {
  const runtimeConfig = useModeRuntimeConfig({ calibration: undefined });
  const mode = useLightingModeOrchestrator({
    runtimeConfig,
    savedCalibration: undefined,
    hueStartConfig: null,
    setHueStartConfig: () => {},
    onRequireCalibration: () => {},
    reportHueSolidColorStatus: () => {},
  });
  const hotReload = useModeHotReload(runtimeConfig, mode.dispatch, mode.lightingMode);
  useRoomGeometrySync(hotReload.onRoomGeometryChange);
  return { runtimeConfig, mode };
}

async function mountOnHue() {
  const view = renderHook(() => useStack());
  act(() => {
    view.result.current.runtimeConfig.prime(storeBlob);
    view.result.current.mode.setSelectedOutputTargets(["hue"]);
  });
  return view;
}

async function startAmbilight(view: Awaited<ReturnType<typeof mountOnHue>>) {
  await act(async () => {
    await view.result.current.mode.handleLightingModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: { brightness: 1 },
    });
  });
}

async function save(partial: Record<string, unknown>) {
  await act(async () => {
    await saveShellState(partial);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  storeBlob = {
    schemaVersion: SHELL_STATE_SCHEMA_VERSION,
    lastHueBridge: { ip: "192.168.1.10" },
    hueAppKey: "app-user",
    hueClientKey: "AABBCCDD11223344",
    lastHueAreaId: "area-1",
    lastOutputTargets: ["hue"],
    roomMap: roomMap(0.2),
  };
  invokeMock.mockImplementation((command: string, args?: { payload?: LightingModeConfig }) => {
    if (command === DEVICE_COMMANDS.SET_LIGHTING_MODE) {
      return Promise.resolve(appliedResult(args!.payload!));
    }
    if (command === HUE_COMMANDS.START_STREAM) {
      return Promise.resolve({
        active: true,
        status: { code: "HUE_STREAM_RUNNING", message: "ok", details: null },
      });
    }
    if (command === CAPTURE_COMMANDS.GET_SCREEN_CAPTURE_PERMISSION) {
      return Promise.resolve({ code: "SCREEN_CAPTURE_PERMISSION_GRANTED" });
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("room geometry hot reload", () => {
  it("carries the geometry on the start that brings Ambilight up", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);

    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0].roomGeometry).toEqual(geometryWithLampAt(0.2));
    view.unmount();
  });

  it("re-dispatches once after the debounce, without restarting the Hue stream", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);
    invokeMock.mockClear();

    await save({ roomMap: roomMap(-0.4) });
    await advance(ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS - 1);
    expect(lightingCalls()).toHaveLength(0);

    await advance(1);
    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0]).toMatchObject({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      roomGeometry: geometryWithLampAt(-0.4),
    });
    expect(hueStreamCalls()).toHaveLength(0);

    // Unforced: an identical projection is deduped rather than re-sent.
    await save({ roomMap: roomMap(-0.4) });
    await advance(1_000);
    expect(lightingCalls()).toHaveLength(1);
    view.unmount();
  });

  it("collapses a drag's burst of saves into one dispatch", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);
    invokeMock.mockClear();

    for (const x of [-0.1, -0.2, -0.3]) {
      await save({ roomMap: roomMap(x) });
      await advance(100);
    }
    await advance(1_000);

    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0].roomGeometry).toEqual(geometryWithLampAt(-0.3));
    view.unmount();
  });

  it("drops the geometry when the TV is removed, so the worker goes back to legacy", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);
    invokeMock.mockClear();

    await save({ roomMap: roomMap(0.2, false) });
    await advance(ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS);

    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0]).not.toHaveProperty("roomGeometry");
    view.unmount();
  });

  it("does not lose a geometry dispatch that lands in the dispatcher's cooldown", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);
    invokeMock.mockClear();

    await save({ roomMap: roomMap(-0.4) });
    await advance(ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS - 5);
    // A brightness commit 5 ms before the reload: the geometry dispatch that
    // follows it falls inside the 20 ms cooldown.
    await act(async () => {
      await view.result.current.mode.handleLightingModeChange({
        kind: LIGHTING_MODE_KIND.AMBILIGHT,
        ambilight: { brightness: 0.5 },
      });
    });
    await advance(5);
    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0].roomGeometry).toEqual(geometryWithLampAt(0.2));

    await advance(100);
    const calls = lightingCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      ambilight: { brightness: 0.5 },
      roomGeometry: geometryWithLampAt(-0.4),
    });
    view.unmount();
  });

  it("dispatches nothing while Ambilight is off, but the next start carries the edit", async () => {
    const view = await mountOnHue();

    await save({ roomMap: roomMap(0.6) });
    await advance(1_000);
    expect(lightingCalls()).toHaveLength(0);

    await startAmbilight(view);
    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0].roomGeometry).toEqual(geometryWithLampAt(0.6));
    view.unmount();
  });

  it("reacts to an area switch, since the placements are per area", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);
    invokeMock.mockClear();

    await save({ lastHueAreaId: "area-2" });
    await advance(ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS);

    expect(lightingCalls()).toHaveLength(1);
    expect(lightingCalls()[0].roomGeometry?.huePlacements).toEqual([]);
    view.unmount();
  });

  it("never persists the geometry inside lightingMode", async () => {
    const view = await mountOnHue();
    await startAmbilight(view);
    await save({ roomMap: roomMap(-0.4) });
    await advance(ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS);
    // Even a caller that hands the hydrated payload back must not persist it.
    await act(async () => {
      await view.result.current.mode.handleLightingModeChange({
        ...lightingCalls()[lightingCalls().length - 1],
        ambilight: { brightness: 0.7 },
      });
    });
    await advance(1_000);

    const persisted = storeBlob.lightingMode as Record<string, unknown> | undefined;
    expect(persisted).toMatchObject({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
    expect(persisted).not.toHaveProperty("roomGeometry");
    view.unmount();
  });
});
