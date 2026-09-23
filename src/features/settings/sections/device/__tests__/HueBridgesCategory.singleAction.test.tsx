// Stale and gate-blocked cards showed Validate twice — once inside the alert,
// once in the footer — and an offline bridge showed Rediscover in the page
// header and the footer. A card's actions live only in its footer; the alert
// carries the message and, at most, a code caption. Real card; props static.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueRuntimeState, HueRuntimeWireStatusCode } from "@/shared/contracts/hue";
import type { HueBridgeSummary } from "@/features/hue/hueOnboardingApi";
import type { HueOnboardingStatus, HueRuntimeStatusView } from "@/features/hue/model/onboardingStatusCodes";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { HueBridgesCategory } from "../HueBridgesCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/mode/modeApi", () => ({ stopHue: vi.fn() }));
vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };
const area = { id: "area-1", name: "Living Room", readiness: { ready: true } } as UseHueOnboardingResult["selectedArea"];

function runtime(state: HueRuntimeState, code: HueRuntimeWireStatusCode): HueRuntimeStatusView {
  return { state, code, message: "backend message", details: null, triggerSource: "system" };
}

function onboarding(code: HueOnboardingStatus["code"]): HueOnboardingStatus {
  return { code, message: "English message from Rust", details: null };
}

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

function expectOneFooterValidate(alertTestId: string, revalidateArea: () => Promise<void>) {
  const validate = screen.getAllByRole("button", { name: "hue:page.validate" });
  expect(validate).toHaveLength(1);
  expect(validate[0]).toHaveClass("lm-dcard-act");
  expect(validate[0].closest(".lm-dcard-actions")).not.toBeNull();
  expect(within(screen.getByTestId(alertTestId)).queryByRole("button")).toBeNull();

  fireEvent.click(validate[0]);
  expect(revalidateArea).toHaveBeenCalledTimes(1);
}

describe("HueBridgesCategory — one Validate control", () => {
  it("stale readiness keeps the message in the banner and Validate in the footer", () => {
    const revalidateArea = vi.fn(async () => {});
    renderCard(hueState({ isReadinessStale: true, revalidateArea }));
    expect(within(screen.getByTestId("hue-stale")).getByText("hue:runtime.checklist.revalidate")).toBeInTheDocument();
    expectOneFooterValidate("hue-stale", revalidateArea);
  });

  it("a blocked gate keeps its checklist and code in the box and Validate in the footer", () => {
    const revalidateArea = vi.fn(async () => {});
    renderCard(
      hueState({
        isReadinessStale: true,
        runtimeStatus: runtime("Idle", "CONFIG_NOT_READY_GATE_BLOCKED"),
        revalidateArea,
      }),
    );
    const box = screen.getByTestId("hue-gate-blocked");
    expect(within(box).getByText("hue:runtime.checklist.revalidate")).toBeInTheDocument();
    expect(within(box).getByTestId("hue-fault-code")).toHaveTextContent("CONFIG_NOT_READY_GATE_BLOCKED");
    expectOneFooterValidate("hue-gate-blocked", revalidateArea);
  });

  it("the busy label stays on the single control while a check runs", () => {
    renderCard(hueState({ isReadinessStale: true, isCheckingReadiness: true }));
    const busy = screen.getAllByRole("button", { name: "hue:actions.checkingReadiness" });
    expect(busy).toHaveLength(1);
    expect(busy[0]).toHaveAttribute("aria-busy", "true");
  });
});

const CARD_STATES: Array<{ name: string; hue: UseHueOnboardingResult }> = [
  { name: "streaming", hue: hueState({ runtimeStatus: runtime("Running", "HUE_STREAM_RUNNING") }) },
  { name: "idle", hue: hueState() },
  {
    name: "statusUnknown",
    hue: hueState({ runtimeStatusReadFailure: { code: "HUE_STREAM_STATUS_UNAVAILABLE", message: "x", details: null } }),
  },
  { name: "stale", hue: hueState({ isReadinessStale: true }) },
  { name: "gateBlocked", hue: hueState({ runtimeStatus: runtime("Idle", "CONFIG_NOT_READY_GATE_BLOCKED") }) },
  { name: "stopPartial", hue: hueState({ runtimeStatus: runtime("Failed", "HUE_STOP_TIMEOUT_PARTIAL") }) },
  { name: "streamFailed", hue: hueState({ runtimeStatus: runtime("Failed", "TRANSIENT_RETRY_EXHAUSTED") }) },
  { name: "reconnecting", hue: hueState({ runtimeStatus: runtime("Reconnecting", "TRANSIENT_RETRY_SCHEDULED") }) },
  { name: "offline", hue: hueState({ bridgeUnreachable: true }) },
  {
    name: "authError",
    hue: hueState({ credentialState: "needs_repair", status: onboarding("AUTH_INVALID_RE_PAIR_REQUIRED") }),
  },
  { name: "pairingFailed", hue: hueState({ credentialState: "needs_repair", status: onboarding("HUE_PAIRING_FAILED") }) },
  {
    name: "pairingTimedOut",
    hue: hueState({ credentialState: "needs_repair", status: onboarding("HUE_PAIRING_LINK_BUTTON_NOT_PRESSED") }),
  },
  {
    name: "pairingDeferred",
    hue: hueState({ credentialState: "needs_repair", status: onboarding("HUE_PAIRING_BRIDGE_BUSY") }),
  },
  { name: "pairing", hue: hueState({ credentialState: "needs_repair", isPairing: true }) },
  {
    name: "pairingLinkButton",
    hue: hueState({ credentialState: "needs_repair", isPairing: true, status: onboarding("HUE_PAIRING_PENDING_LINK_BUTTON") }),
  },
  { name: "areaSelect", hue: hueState({ selectedAreaId: null, selectedArea: null }) },
];

describe("HueBridgesCategory — no card state offers an action twice", () => {
  it.each(CARD_STATES)("$name", ({ hue }) => {
    renderCard(hue);
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size, `duplicate controls: ${names.join(" | ")}`).toBe(names.length);
  });

  it.each(CARD_STATES)("$name footer actions carry the tap-target class", ({ hue }) => {
    const { container } = renderCard(hue);
    const footer = container.querySelector(".lm-dcard .lm-dcard-actions");
    expect(footer).not.toBeNull();
    for (const button of within(footer as HTMLElement).queryAllByRole("button")) {
      expect(button).toHaveClass("lm-dcard-act");
    }
  });
});
