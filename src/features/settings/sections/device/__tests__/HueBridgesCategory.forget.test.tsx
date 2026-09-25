// Forget used to only drop the selection: nothing was saved, the keychain kept
// the pair, the stream kept running, and the next launch brought the bridge
// back. It now asks first and then runs the full forget; the card is gone
// afterwards, so the page itself says what happened and what is left to do on
// the bridge's side.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HueForgetStatus } from "@/shared/contracts/hue";
import type { HueRuntimeStatusView } from "@/features/hue/model/onboardingStatusCodes";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { HueBridgesCategory } from "../HueBridgesCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };
const area = { id: "area-1", name: "Living Room", readiness: { ready: true } } as UseHueOnboardingResult["selectedArea"];
const idle: HueRuntimeStatusView = {
  state: "Idle",
  code: "HUE_STREAM_STOPPED",
  message: "",
  details: null,
  triggerSource: "system",
};

function hueState(overrides: Partial<UseHueOnboardingResult>): UseHueOnboardingResult {
  const noop = async () => {};
  return {
    step: "ready",
    bridges: [bridge],
    selectedBridgeId: bridge.id,
    selectedBridge: bridge,
    manualIp: "",
    manualIpError: null,
    credentialState: "valid",
    bridgeUnreachable: false,
    credentials: { username: "", clientKey: "" },
    areaGroups: [],
    selectedAreaId: "area-1",
    selectedArea: area,
    canStartHue: true,
    isReadinessStale: false,
    isDiscovering: false,
    isPairing: false,
    isLoadingAreas: false,
    isCheckingReadiness: false,
    isValidatingCredential: false,
    status: null,
    runtimeStatus: idle,
    runtimeStatusReadFailure: null,
    runtimeTargets: [],
    isRuntimeMutating: false,
    areaChannels: [],
    isLoadingChannels: false,
    channelsStatus: null,
    channelsFromBridge: false,
    refreshChannels: async () => null,
    discover: noop,
    selectBridge: () => {},
    forgetBridge: async () => null,
    setManualIp: () => {},
    submitManualIp: noop,
    recheckBridge: noop,
    pair: noop,
    refreshAreas: noop,
    selectArea: () => {},
    revalidateArea: noop,
    startRuntime: noop,
    retryRuntimeTarget: noop,
    lightNames: {},
    identifyLights: async () => ({ code: "HUE_IDENTIFY_OK", message: "", details: null }),
    ...overrides,
  };
}

function renderCategory(hue: UseHueOnboardingResult) {
  return render(
    <HueBridgesCategory
      isActive
      hue={hue}
      channelPlacements={[]}
      onPositionChange={async () => {}}
      persistError={false}
      zones={[]}
      onStopHue={async () => {}}
    />,
  );
}

const forgotten = (code: HueForgetStatus["code"]): HueForgetStatus => ({ code, message: "", details: null });

describe("HueBridgesCategory — Forget", () => {
  it("asks first, and forgets nothing when the answer is Cancel", async () => {
    const forgetBridge = vi.fn(async () => forgotten("HUE_FORGET_OK"));
    const selectBridge = vi.fn();
    const user = userEvent.setup();
    renderCategory(hueState({ forgetBridge, selectBridge }));

    await user.click(screen.getByRole("button", { name: "hue:page.forgotBridge" }));

    const dialog = screen.getByTestId("hue-forget-confirm");
    expect(dialog).toHaveTextContent("hue:page.forgetConfirm.body");
    await user.click(screen.getByRole("button", { name: "hue:page.cancel" }));

    expect(screen.queryByTestId("hue-forget-confirm")).toBeNull();
    expect(forgetBridge).not.toHaveBeenCalled();
    expect(selectBridge).not.toHaveBeenCalled();
  });

  it("forgets on confirmation and says what is left to do on the bridge", async () => {
    const forgetBridge = vi.fn(async () => forgotten("HUE_FORGET_OK"));
    const user = userEvent.setup();
    renderCategory(hueState({ forgetBridge }));

    await user.click(screen.getByRole("button", { name: "hue:page.forgotBridge" }));
    await user.click(screen.getByTestId("hue-forget-confirm-yes"));

    expect(forgetBridge).toHaveBeenCalledTimes(1);
    const note = await screen.findByTestId("hue-forget-result");
    expect(note).toHaveTextContent("hue:page.forgetResult.ok");
    expect(note).not.toHaveTextContent("HUE_FORGET_OK");
  });

  it.each([
    ["HUE_FORGET_PARTIAL", "hue:page.forgetResult.partial"],
    ["HUE_FORGET_FAILED", "hue:page.forgetResult.failed"],
  ] as const)("reports %s with its code as a caption", async (code, copy) => {
    const user = userEvent.setup();
    renderCategory(hueState({ forgetBridge: async () => forgotten(code) }));

    await user.click(screen.getByRole("button", { name: "hue:page.forgotBridge" }));
    await user.click(screen.getByTestId("hue-forget-confirm-yes"));

    const note = await screen.findByTestId("hue-forget-result");
    expect(note).toHaveTextContent(copy);
    expect(note).toHaveTextContent(code);
  });

  it("a bridge with no key is only let go of: nothing to confirm, nothing to forget", async () => {
    const forgetBridge = vi.fn(async () => forgotten("HUE_FORGET_OK"));
    const selectBridge = vi.fn();
    const user = userEvent.setup();
    renderCategory(
      hueState({
        forgetBridge,
        selectBridge,
        credentials: null,
        credentialState: "needs_repair",
        status: { code: "HUE_PAIRING_FAILED", message: "", details: null },
      }),
    );

    await user.click(screen.getByRole("button", { name: "hue:page.forgotBridge" }));

    await waitFor(() => expect(selectBridge).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId("hue-forget-confirm")).toBeNull();
    expect(forgetBridge).not.toHaveBeenCalled();
  });

  it("Cancel on a pairing run stays a plain deselect", async () => {
    const forgetBridge = vi.fn(async () => forgotten("HUE_FORGET_OK"));
    const selectBridge = vi.fn();
    const user = userEvent.setup();
    renderCategory(hueState({ forgetBridge, selectBridge, credentials: null, isPairing: true }));

    await user.click(screen.getByRole("button", { name: "hue:page.cancel" }));

    expect(selectBridge).toHaveBeenCalledWith(null);
    expect(forgetBridge).not.toHaveBeenCalled();
  });
});
