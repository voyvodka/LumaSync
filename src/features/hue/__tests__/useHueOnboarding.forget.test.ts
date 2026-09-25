import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUE_CREDENTIAL_BACKENDS,
  HUE_CREDENTIAL_STATUS,
  HUE_FORGET_STATUS,
  type HueForgetStatus,
} from "@/shared/contracts/hue";
import { hueCredentialEvents } from "../hueCredentialEvents";
import { __resetHueHealthStoreForTests } from "../state/hueHealthStore";
import { resetHealth } from "./fakeHueHealth";
import { useHueOnboarding } from "../useHueOnboarding";
import type * as modeApiModule from "@/features/mode/modeApi";
import type * as hueOnboardingApiModule from "../hueOnboardingApi";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const forgetMock = vi.fn<typeof hueOnboardingApiModule.forgetHueBridge>();

vi.mock("../hueHealthApi", async () => (await import("./fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", () => ({
  restartHue: vi.fn<typeof modeApiModule.restartHue>(),
  startHue: vi.fn<typeof modeApiModule.startHue>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: Parameters<typeof shellSaveMock>) => shellSaveMock(...args),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: vi.fn<typeof hueOnboardingApiModule.checkHueStreamReadiness>(),
  discoverHueBridges: vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>(),
  forgetHueBridge: (bridgeId: string) => forgetMock(bridgeId),
  getHueAreaChannels: vi.fn<typeof hueOnboardingApiModule.getHueAreaChannels>().mockResolvedValue({
    status: { code: "HUE_AREA_CHANNELS_EMPTY", message: "", details: null },
    channels: [],
  }),
  getHueLightNames: vi.fn<typeof hueOnboardingApiModule.getHueLightNames>(),
  identifyHueLights: vi.fn<typeof hueOnboardingApiModule.identifyHueLights>(),
  listHueEntertainmentAreas: vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>().mockResolvedValue({
    status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
    areas: [{ id: "area-1", name: "Living room", channelCount: 2, roomName: null, activeStreamer: false }],
  }),
  migrateHueCredentials: vi.fn<typeof hueOnboardingApiModule.migrateHueCredentials>(),
  pairHueBridge: vi.fn<typeof hueOnboardingApiModule.pairHueBridge>(),
  validateHueCredentials: vi.fn<typeof hueOnboardingApiModule.validateHueCredentials>().mockResolvedValue({
    status: { code: "HUE_CREDENTIAL_VALID", message: "ok", details: null },
    valid: true,
  }),
  verifyHueBridgeIp: vi.fn<typeof hueOnboardingApiModule.verifyHueBridgeIp>(),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };

const answer = (code: HueForgetStatus["code"]): HueForgetStatus => ({ code, message: "", details: null });

async function pairedHook() {
  const hook = renderHook(() => useHueOnboarding());
  await waitFor(() => expect(hook.result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID));
  expect(hook.result.current.selectedBridgeId).toBe(BRIDGE.id);
  return hook;
}

describe("useHueOnboarding — forgetBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    resetHealth();
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      lastHueAreaId: "area-1",
      credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
    });
    shellSaveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("asks Rust to forget the selected bridge, then lets go of everything it held", async () => {
    forgetMock.mockResolvedValue(answer(HUE_FORGET_STATUS.OK));
    const events: string[] = [];
    const unsubscribe = hueCredentialEvents.subscribe((event) => events.push(event.reason));
    const { result } = await pairedHook();

    let response: HueForgetStatus | null = null;
    await act(async () => {
      response = await result.current.forgetBridge();
    });

    expect(forgetMock).toHaveBeenCalledWith(BRIDGE.id);
    expect(response).toEqual(answer(HUE_FORGET_STATUS.OK));
    expect(result.current.selectedBridgeId).toBeNull();
    expect(result.current.credentials).toBeNull();
    expect(result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.UNKNOWN);
    expect(result.current.selectedAreaId).toBeNull();
    expect(result.current.bridges).toEqual([]);
    expect(result.current.status).toBeNull();
    expect(events).toContain("forgotten");
    unsubscribe();
  });

  it("keeps the pairing on screen when nothing was forgotten", async () => {
    forgetMock.mockResolvedValue(answer(HUE_FORGET_STATUS.FAILED));
    const { result } = await pairedHook();

    await act(async () => {
      await result.current.forgetBridge();
    });

    expect(result.current.selectedBridgeId).toBe(BRIDGE.id);
    expect(result.current.credentials).not.toBeNull();
  });

  it("a rejected invoke reads as a failed forget, never a thrown one", async () => {
    forgetMock.mockRejectedValue(new Error("ipc torn down"));
    const { result } = await pairedHook();

    let response: HueForgetStatus | null = null;
    await act(async () => {
      response = await result.current.forgetBridge();
    });

    expect(response).toMatchObject({ code: HUE_FORGET_STATUS.FAILED, details: "ipc torn down" });
    expect(result.current.selectedBridgeId).toBe(BRIDGE.id);
  });
});
