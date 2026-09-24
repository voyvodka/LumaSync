// "Change area" only re-read the list: `refreshAreas` keeps the saved area, and
// the list opened only while no area was set, so a bridge with an area never
// showed it again and the area could not be changed from the card.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueBridgeSummary } from "@/features/hue/hueOnboardingApi";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { HueBridgesCategory } from "../HueBridgesCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

// Stubbed so nothing here can reach the Tauri transport.
vi.mock("@/features/mode/modeApi", () => ({}));
vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };

const areaGroups = [
  {
    roomName: "Living room",
    areas: [
      { id: "tv", name: "TV Area", channelCount: 3, activeStreamer: false },
      { id: "desk", name: "Desk", channelCount: 2, activeStreamer: false },
    ],
  },
] as unknown as UseHueOnboardingResult["areaGroups"];
const [tvArea, deskArea] = areaGroups[0]?.areas ?? [];

function hueState(overrides: Partial<UseHueOnboardingResult> = {}): UseHueOnboardingResult {
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
    credentials: { username: "app-user", clientKey: "AABBCCDD" },
    areaGroups,
    selectedAreaId: "tv",
    selectedArea: tvArea ?? null,
    canStartHue: true,
    isReadinessStale: false,
    isDiscovering: false,
    isPairing: false,
    isLoadingAreas: false,
    isCheckingReadiness: false,
    isValidatingCredential: false,
    status: null,
    runtimeStatus: null,
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
    setManualIp: () => {},
    submitManualIp: noop,
    pair: noop,
    refreshAreas: noop,
    selectArea: () => {},
    revalidateArea: noop,
    startRuntime: noop,
    retryRuntimeTarget: noop,
    ...overrides,
  };
}

function card(hue: UseHueOnboardingResult) {
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

const areaList = () => screen.queryByRole("group", { name: "hue:areas.selectLabel" });
const openList = () => fireEvent.click(screen.getByRole("button", { name: "hue:page.changeArea" }));

describe("HueBridgesCategory — Change area", () => {
  it("opens the list with the area in use highlighted and re-reads the bridge's areas", () => {
    const refreshAreas = vi.fn<UseHueOnboardingResult["refreshAreas"]>(async () => {});
    render(card(hueState({ refreshAreas })));
    expect(areaList()).toBeNull();

    openList();

    const list = areaList();
    expect(list).not.toBeNull();
    const current = within(list as HTMLElement).getByRole("button", { name: "TV Area" });
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(current).toHaveFocus();
    expect(refreshAreas).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "hue:page.confirmArea" })).toBeEnabled();
  });

  it("keeps the old area on Cancel and hands focus back to Change area", () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    render(card(hueState({ selectArea })));
    openList();
    fireEvent.click(screen.getByRole("button", { name: "Desk" }));

    fireEvent.click(screen.getByRole("button", { name: "hue:page.cancel" }));

    expect(areaList()).toBeNull();
    expect(selectArea).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "hue:page.changeArea" })).toHaveFocus();
  });

  it("switches on Confirm, then checks the new area once it is the selection", () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    const revalidateArea = vi.fn<UseHueOnboardingResult["revalidateArea"]>(async () => {});
    const { rerender } = render(card(hueState({ selectArea, revalidateArea })));
    openList();
    fireEvent.click(screen.getByRole("button", { name: "Desk" }));
    expect(screen.getByRole("button", { name: "Desk" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "hue:page.confirmArea" }));

    expect(selectArea).toHaveBeenCalledWith("desk");
    expect(areaList()).toBeNull();
    // Run before the hook carries the new area, the check would read the old one.
    expect(revalidateArea).not.toHaveBeenCalled();
    act(() => {
      rerender(card(hueState({ selectArea, revalidateArea, selectedAreaId: "desk", selectedArea: deskArea ?? null })));
    });
    expect(revalidateArea).toHaveBeenCalledOnce();
  });

  it("closes without a switch when Confirm keeps the area in use", () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    render(card(hueState({ selectArea })));
    openList();
    fireEvent.click(screen.getByRole("button", { name: "hue:page.confirmArea" }));

    expect(areaList()).toBeNull();
    expect(selectArea).not.toHaveBeenCalled();
  });

  it("drops the list when the card leaves a state that offers it", () => {
    const { rerender } = render(card(hueState()));
    openList();
    expect(areaList()).not.toBeNull();

    rerender(card(hueState({ bridgeUnreachable: true })));
    expect(areaList()).toBeNull();
    rerender(card(hueState()));
    expect(areaList()).toBeNull();
  });
});
