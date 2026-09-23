// A paired bridge whose first probe was still in flight showed "No reachable
// output — connect a strip or pair a Hue bridge" on launch. Rendered through
// SettingsLayout so the verdict has to survive the hop the shell makes.

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import { SECTION_IDS } from "@/shared/contracts/shell";
import { SettingsLayout } from "../../../SettingsLayout";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
  },
}));

async function renderCompact(
  hue: {
    configured: boolean;
    reachable: boolean;
    verdict: HueProbeVerdict | null;
  },
  bootstrapDone = true,
) {
  await act(async () => {
    render(
      <SettingsLayout
        uiMode="compact"
        activeSection={SECTION_IDS.LIGHTS}
        onSectionChange={() => Promise.resolve()}
        lightingMode={{ kind: "off" }}
        outputTargets={["hue"]}
        localSink={null}
        hueConfigured={hue.configured}
        bootstrapDone={bootstrapDone}
        hueReachable={hue.reachable}
        hueProbeVerdict={hue.verdict}
        hueStreaming={false}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onCalibrationSaved={vi.fn()}
        onCheckForUpdates={vi.fn()}
        isCheckingForUpdates={false}
        onOpenDevices={vi.fn()}
      />,
    );
  });
}

const offlineTitle = () => screen.queryByText("common:output.offline.title");
const openDevices = () => screen.queryByRole("button", { name: "common:output.offline.action" });

describe("CompactLayout output gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says it is checking — not that nothing is paired — while the bridge's first probe runs", async () => {
    await renderCompact({ configured: true, reachable: false, verdict: null });

    expect(screen.getByTestId("output-checking")).toHaveTextContent("common:output.checking");
    expect(offlineTitle()).not.toBeInTheDocument();
    expect(openDevices()).not.toBeInTheDocument();
    // Still nowhere confirmed to send frames, so the gate holds.
    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
    expect(screen.getByTestId("mode-button-solid")).toBeDisabled();
    expect(screen.getByTestId("mode-button-off")).toBeEnabled();
  });

  it("shows the offline banner once the probe says the bridge did not answer", async () => {
    await renderCompact({ configured: true, reachable: false, verdict: "unreachable" });

    expect(offlineTitle()).toBeInTheDocument();
    expect(openDevices()).toBeInTheDocument();
    expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument();
    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
  });

  it("shows the offline banner when no bridge is paired at all", async () => {
    await renderCompact({ configured: false, reachable: false, verdict: null });

    expect(offlineTitle()).toBeInTheDocument();
    expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument();
  });

  it("reads an unset pairing as checking, not missing, until boot has loaded it", async () => {
    await renderCompact({ configured: false, reachable: false, verdict: null }, false);

    expect(screen.getByTestId("output-checking")).toBeInTheDocument();
    expect(offlineTitle()).not.toBeInTheDocument();
    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
  });

  it("enables the modes and shows neither state once the bridge answers", async () => {
    await renderCompact({ configured: true, reachable: true, verdict: "reachable" });

    expect(offlineTitle()).not.toBeInTheDocument();
    expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument();
    expect(screen.getByTestId("mode-button-ambilight")).toBeEnabled();
    expect(screen.getByTestId("mode-button-solid")).toBeEnabled();
  });
});
