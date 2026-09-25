// The CI UI probe reported the manual bridge IP field with no accessible name,
// and the entertainment-area list said which area was chosen, and which one
// another app holds, only in CSS classes. Real card; props static.

import { fireEvent, render, screen, within } from "@testing-library/react";
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
      { id: "free", name: "TV Area", channelCount: 3, activeStreamer: false },
      { id: "held", name: "Desk", channelCount: 2, activeStreamer: true },
    ],
  },
] as unknown as UseHueOnboardingResult["areaGroups"];

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
    areaGroups: [],
    selectedAreaId: null,
    selectedArea: null,
    canStartHue: false,
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
    recheckBridge: noop,
    pair: noop,
    refreshAreas: noop,
    selectArea: () => {},
    revalidateArea: noop,
    startRuntime: noop,
    retryRuntimeTarget: noop,
    ...overrides,
  };
}

function renderCard(hue: UseHueOnboardingResult) {
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

const noBridge = { selectedBridgeId: null, selectedBridge: null, bridges: [] };

describe("manual bridge IP field", () => {
  it("has a name and points at the hint under the title", () => {
    renderCard(hueState(noBridge));
    const field = screen.getByRole("textbox", { name: "hue:manualIp.inputLabel" });
    expect(field).toHaveAccessibleDescription("hue:manualIp.description");
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("is marked invalid and described by the error while one is shown", () => {
    renderCard(hueState({ ...noBridge, manualIp: "300.1", manualIpError: "hue:manualIp.invalid" }));
    const field = screen.getByRole("textbox", { name: "hue:manualIp.inputLabel" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("hue:manualIp.description hue:manualIp.invalid");
  });
});

describe("entertainment-area list", () => {
  it("is a group named by its label, with each area's choice state in ARIA", () => {
    renderCard(hueState({ areaGroups }));
    const list = screen.getByRole("group", { name: "hue:areas.selectLabel" });
    const free = within(list).getByRole("button", { name: "TV Area" });
    const held = within(list).getByRole("button", { name: "Desk" });

    expect(free).toHaveAttribute("aria-pressed", "false");
    expect(free).not.toHaveAttribute("aria-disabled");
    expect(free).toHaveAccessibleDescription("hue:areas.channels:3");

    expect(held).toHaveAttribute("aria-pressed", "false");
    expect(held).toHaveAttribute("aria-disabled", "true");
    expect(held).toHaveAccessibleDescription("hue:areas.channels:2 hue:areas.activeStreamer");
  });

  it("highlights a free area, ignores one another app holds, and commits on Confirm", () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    renderCard(hueState({ areaGroups, selectArea }));
    const confirm = screen.getByRole("button", { name: "hue:page.confirmArea" });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Desk" }));
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "TV Area" }));
    expect(screen.getByRole("button", { name: "TV Area" })).toHaveAttribute("aria-pressed", "true");
    expect(selectArea).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    expect(selectArea).toHaveBeenCalledWith("free");
  });
});

// The card was a `role="button"` holding the "+ Pair" button, and the two did
// different things: the card selected the bridge unpaired, which read as
// expired credentials.
describe("found-bridge card", () => {
  const found = { ...noBridge, bridges: [bridge, { id: "bridge-2", ip: "192.168.1.11", name: "Office" }] };

  it("is static, with + Pair as its only control, named for its bridge", () => {
    const { container } = renderCard(hueState(found));
    const cards = container.querySelectorAll(".lm-dcard");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).not.toHaveAttribute("role");
      expect(card).not.toHaveAttribute("tabindex");
      expect(within(card as HTMLElement).getAllByRole("button")).toHaveLength(1);
    }
    const pairButtons = screen.getAllByRole("button", { name: "hue:page.addBridge" });
    expect(pairButtons[0]).toHaveAccessibleDescription("Test Bridge");
    expect(pairButtons[1]).toHaveAccessibleDescription("Office");
  });

  it("pairs from the button and does nothing from the card body", () => {
    const pair = vi.fn<UseHueOnboardingResult["pair"]>(async () => {});
    const selectBridge = vi.fn<UseHueOnboardingResult["selectBridge"]>();
    const { container } = renderCard(hueState({ ...found, pair, selectBridge }));
    fireEvent.click(container.querySelector(".lm-dcard") as HTMLElement);
    expect(pair).not.toHaveBeenCalled();
    expect(selectBridge).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "hue:page.addBridge" })[1] as HTMLElement);
    expect(pair).toHaveBeenCalledWith("bridge-2");
  });
});

describe("decorative spinners", () => {
  it("hide the scan spinner from assistive tech; the text beside it says it", () => {
    const { container } = renderCard(hueState({ ...noBridge, isDiscovering: true }));
    const spinner = container.querySelector(".lm-hue-scan-card .lm-hue-wait-sp");
    expect(spinner).toHaveAttribute("aria-hidden", "true");
  });
});
