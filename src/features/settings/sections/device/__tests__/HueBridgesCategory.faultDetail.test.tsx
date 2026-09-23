// A revoked app key showed two Re-pair buttons (one in the alert, one in the
// footer) and the raw AUTH_INVALID_RE_PAIR_REQUIRED as the large headline of
// a stat cell. Every card state now keeps its actions in the footer and a raw
// code as a small caption under its message. Real card; props are static.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueRuntimeActionHint, HueRuntimeState, HueRuntimeWireStatusCode } from "@/shared/contracts/hue";
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

function runtime(
  state: HueRuntimeState,
  code: HueRuntimeWireStatusCode,
  extra: { actionHint?: HueRuntimeActionHint; remainingAttempts?: number; nextAttemptMs?: number } = {},
): HueRuntimeStatusView {
  return { state, code, message: "backend message", details: null, triggerSource: "system", ...extra };
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

/** The code is a caption, never the value of a stat cell. */
function expectCodeAsDetail(container: HTMLElement, code: string): HTMLElement {
  const detail = screen.getByTestId("hue-fault-code");
  expect(detail).toHaveClass("lm-hue-code");
  expect(detail).toHaveTextContent(`hue:card.codeLabel ${code}`);
  expect(detail).not.toHaveAttribute("aria-hidden");
  expect(within(detail).getByText(code).tagName).toBe("CODE");
  for (const cell of container.querySelectorAll(".lm-dcard-cell")) {
    expect(cell.textContent).not.toContain(code);
  }
  return detail;
}

describe("HueBridgesCategory — revoked app key", () => {
  const revoked = () =>
    hueState({
      credentialState: "needs_repair",
      status: onboarding("AUTH_INVALID_RE_PAIR_REQUIRED"),
    });

  it("offers exactly one Re-pair control, in the footer, and it pairs", () => {
    const pair = vi.fn(async () => {});
    renderCard({ ...revoked(), pair });

    const repair = screen.getAllByRole("button", { name: "hue:runtime.actions.repair" });
    expect(repair).toHaveLength(1);
    expect(repair[0].closest(".lm-dcard-actions")).not.toBeNull();
    expect(within(screen.getByTestId("hue-auth-error")).queryByRole("button")).toBeNull();

    fireEvent.click(repair[0]);
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("offers one Re-pair control on a failed pairing too, which shares the footer", () => {
    renderCard(
      hueState({
        credentialState: "needs_repair",
        status: onboarding("HUE_PAIRING_FAILED"),
      }),
    );
    expect(screen.getAllByRole("button", { name: "hue:runtime.actions.repair" })).toHaveLength(1);
  });

  it("shows the raw code as a small detail inside the alert, not as a stat cell", () => {
    const { container } = renderCard(revoked());
    const alert = screen.getByTestId("hue-auth-error");
    expect(alert).toHaveAttribute("role", "status");
    const detail = expectCodeAsDetail(container, "AUTH_INVALID_RE_PAIR_REQUIRED");
    expect(alert).toContainElement(detail);
    // The credential cell stays: it is a translated status, not a raw code.
    expect(screen.getByText("hue:card.cellCredentialInvalid")).toBeInTheDocument();
  });
});

describe("HueBridgesCategory — raw codes are a detail in every state that shows one", () => {
  const cases: Array<{ name: string; hue: UseHueOnboardingResult; code: string; container?: string }> = [
    {
      name: "streamFailed",
      hue: hueState({ runtimeStatus: runtime("Failed", "TRANSIENT_RETRY_EXHAUSTED", { actionHint: "retry" }) }),
      code: "TRANSIENT_RETRY_EXHAUSTED",
      container: "hue-stream-failed",
    },
    {
      name: "statusUnknown",
      hue: hueState({
        runtimeStatusReadFailure: { code: "HUE_STREAM_STATUS_UNAVAILABLE", message: "IPC closed", details: null },
      }),
      code: "HUE_STREAM_STATUS_UNAVAILABLE",
      container: "hue-status-unavailable",
    },
    {
      name: "reconnecting",
      hue: hueState({
        status: onboarding("HUE_STREAM_RECOVERY_FAILED"),
        runtimeStatus: runtime("Reconnecting", "TRANSIENT_RETRY_SCHEDULED", { remainingAttempts: 3, nextAttemptMs: 2000 }),
      }),
      code: "HUE_STREAM_RECOVERY_FAILED",
    },
    {
      name: "stopPartial",
      hue: hueState({ runtimeStatus: runtime("Failed", "HUE_STOP_TIMEOUT_PARTIAL") }),
      code: "HUE_STOP_TIMEOUT_PARTIAL",
    },
    {
      name: "gateBlocked",
      hue: hueState({ runtimeStatus: runtime("Idle", "CONFIG_NOT_READY_GATE_BLOCKED") }),
      code: "CONFIG_NOT_READY_GATE_BLOCKED",
    },
  ];

  it.each(cases)("$name", ({ hue, code, container: testId }) => {
    const { container } = renderCard(hue);
    const detail = expectCodeAsDetail(container, code);
    if (testId) expect(screen.getByTestId(testId)).toContainElement(detail);
  });

  it("keeps Re-pair single on a stream the runtime says was refused", () => {
    renderCard(hueState({ runtimeStatus: runtime("Failed", "AUTH_INVALID_CREDENTIALS", { actionHint: "repair" }) }));
    expect(screen.getAllByRole("button", { name: "hue:runtime.actions.repair" })).toHaveLength(1);
    expect(screen.getByTestId("hue-fault-code")).toHaveTextContent("AUTH_INVALID_CREDENTIALS");
  });

  it("shows no code caption on a healthy card", () => {
    renderCard(hueState({ runtimeStatus: runtime("Idle", "HUE_STREAM_IDLE") }));
    expect(screen.getByText("hue:page.pill.ready", { selector: ".lm-dcard-pill" })).toBeInTheDocument();
    expect(screen.queryByTestId("hue-fault-code")).toBeNull();
  });
});
