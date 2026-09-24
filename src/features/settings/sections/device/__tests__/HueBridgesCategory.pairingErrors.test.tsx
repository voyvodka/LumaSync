// A pairing refusal the bridge names — busy, rate-limited, bad devicetype —
// through the real onboarding hook and the real bridge card, with only the
// invoke bridge faked. None of them means the stored credentials expired.

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHueOnboardingCore } from "@/features/hue/state/useHueOnboardingCore";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { __resetHueHealthStoreForTests } from "@/features/hue/state/hueHealthStore";
import { HueBridgesCategory } from "../HueBridgesCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({}),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

const pairBridgeMock = vi.fn();
vi.mock("@/features/hue/hueOnboardingApi", () => ({
  checkHueStreamReadiness: vi.fn(),
  discoverHueBridges: vi.fn().mockResolvedValue({
    status: { code: "HUE_DISCOVERY_OK", message: "ok", details: null },
    bridges: [{ id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" }],
  }),
  listHueEntertainmentAreas: vi.fn(),
  migrateHueCredentials: vi.fn(),
  pairHueBridge: (...args: unknown[]) => pairBridgeMock(...args),
  validateHueCredentials: vi.fn(),
  verifyHueBridgeIp: vi.fn(),
}));

vi.mock("@/features/mode/modeApi", () => ({ stopHue: vi.fn() }));
vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

let hook: ReturnType<typeof useHueOnboardingCore>;

/** The card reads runtime and channels too; with no stream they are at rest. */
function Harness() {
  hook = useHueOnboardingCore();
  const { state } = hook;
  const hue: UseHueOnboardingResult = {
    ...state,
    selectedBridge: hook.selectedBridge,
    selectedArea: hook.selectedArea,
    canStartHue: hook.canStartHue,
    isReadinessStale: hook.isReadinessStale,
    runtimeStatus: null,
    runtimeStatusReadFailure: null,
    runtimeTargets: [],
    isRuntimeMutating: false,
    areaChannels: [],
    isLoadingChannels: false,
    channelsStatus: null,
    channelsFromBridge: false,
    refreshChannels: async () => null,
    discover: hook.discover,
    selectBridge: hook.selectBridge,
    setManualIp: hook.setManualIp,
    submitManualIp: hook.submitManualIp,
    pair: hook.pair,
    refreshAreas: hook.refreshAreas,
    selectArea: hook.selectArea,
    revalidateArea: hook.revalidateArea,
    startRuntime: async () => {},
    retryRuntimeTarget: async () => {},
  };
  return (
    <HueBridgesCategory
      isActive
      hue={hue}
      channelPlacements={[]}
      onPositionChange={async () => {}}
      persistError={false}
      zones={[]}
      onStopHue={async () => {}}
    />
  );
}

async function pairAndGetRefused(code: string) {
  pairBridgeMock.mockResolvedValue({
    status: { code, message: "English message from Rust", details: null },
    credentials: null,
  });
  render(<Harness />);
  await act(async () => {
    await hook.discover();
  });
  await act(async () => {
    await hook.pair("bridge-1");
  });
}

function expectNoCredentialFault() {
  expect(screen.queryByText("hue:credential.needsRepair")).toBeNull();
  expect(screen.queryByText("hue:credential.repairHint")).toBeNull();
  expect(screen.queryByText("hue:page.pill.authError")).toBeNull();
}

describe("HueBridgesCategory — named pairing refusals", () => {
  beforeEach(() => {
    pairBridgeMock.mockReset();
    __resetHueHealthStoreForTests();
  });

  it("tells the user to wait when the bridge is busy", async () => {
    await pairAndGetRefused("HUE_PAIRING_BRIDGE_BUSY");

    const notice = screen.getByTestId("hue-pairing-deferred");
    expect(notice).toHaveTextContent("hue:pairing.errors.BRIDGE_BUSY.description");
    expect(screen.getByText("hue:page.pill.wait")).toBeInTheDocument();
    expect(screen.getByText("hue:pair.tryAgain")).toBeInTheDocument();
    expectNoCredentialFault();
  });

  it("tells the user to wait a minute when pairing is rate-limited", async () => {
    await pairAndGetRefused("HUE_PAIRING_RATE_LIMITED");

    expect(screen.getByTestId("hue-pairing-deferred")).toHaveTextContent(
      "hue:pairing.errors.RATE_LIMITED.description",
    );
    expectNoCredentialFault();
  });

  it("explains a rejected devicetype as a failed pairing, not expired credentials", async () => {
    await pairAndGetRefused("HUE_PAIRING_DEVICETYPE_INVALID");

    expect(screen.getByTestId("hue-pairing-failed-reason")).toHaveTextContent(
      "hue:pairing.errors.DEVICETYPE_INVALID.description",
    );
    expect(screen.getByText("hue:page.pill.failed")).toBeInTheDocument();
    expectNoCredentialFault();
  });

  it("keeps a real credential rejection on the re-pair prompt", async () => {
    await pairAndGetRefused("HUE_CREDENTIAL_INVALID");

    expect(screen.getAllByText("hue:credential.needsRepair").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("hue-pairing-deferred")).toBeNull();
  });
});
