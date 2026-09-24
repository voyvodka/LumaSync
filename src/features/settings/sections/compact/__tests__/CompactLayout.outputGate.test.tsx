// A paired bridge whose first probe was still in flight showed "No reachable
// output — connect a strip or pair a Hue bridge" on launch. Rendered through
// SettingsLayout so the verdict has to survive the hop the shell makes.
//
// The layout only gates the buttons now; what the shell says about the gate
// (checking, no output) is the notice queue's, and is covered in
// `src/features/shell/notices/__tests__/buildShellNotices.test.ts` and through App.

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
        onStopHueOutput={async () => {}}
        onCalibrationSaved={vi.fn()}
        onCheckForUpdates={vi.fn()}
        isCheckingForUpdates={false}
      />,
    );
  });
}

describe("CompactLayout output gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds the gate while the bridge's first probe runs", async () => {
    await renderCompact({ configured: true, reachable: false, verdict: null });

    // Still nowhere confirmed to send frames, so the gate holds.
    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
    expect(screen.getByTestId("mode-button-solid")).toBeDisabled();
    expect(screen.getByTestId("mode-button-off")).toBeEnabled();
  });

  it("holds the gate once the probe says the bridge did not answer", async () => {
    await renderCompact({ configured: true, reachable: false, verdict: "unreachable" });

    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
  });

  it("holds the gate on an unset pairing until boot has loaded it", async () => {
    await renderCompact({ configured: false, reachable: false, verdict: null }, false);

    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
  });

  it("carries no notice of its own — the shell's slot says why the modes are dim", async () => {
    await renderCompact({ configured: false, reachable: false, verdict: null });

    expect(screen.queryByText("shell:notices.messages.outputNone")).not.toBeInTheDocument();
    expect(screen.queryByTestId("output-checking")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("enables the modes once the bridge answers", async () => {
    await renderCompact({ configured: true, reachable: true, verdict: "reachable" });

    expect(screen.getByTestId("mode-button-ambilight")).toBeEnabled();
    expect(screen.getByTestId("mode-button-solid")).toBeEnabled();
  });
});
