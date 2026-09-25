// How the room map hands LED counts to LED Setup, and how LED Setup keeps its
// draft. The counts used to be parked in memory with no navigation, then merged
// into LED Setup's *baseline* on whatever visit came next — so Cancel dropped
// them without a word and Save applied them unnoticed.

import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedCalibrationConfig, LedSegmentCounts } from "@/features/calibration/model/contracts";
import type { LeaveGuard } from "@/features/shell/navigationStore";
import { SECTION_IDS } from "@/shared/contracts/shell";
import { renderWithShellStores } from "@/test/shellProviders";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({}), save: () => Promise.resolve() },
}));

const syncStripLedCount = vi.hoisted(() => vi.fn<(totalLeds: number, port: string | null) => Promise<void>>(async () => {}));
vi.mock("../sections/device/usbStripRoster", () => ({ syncStripLedCount }));

const DERIVED: LedSegmentCounts = { top: 50, right: 30, bottom: 50, left: 30 };

vi.mock("@/features/room-map/ui/RoomMapEditor", () => ({
  RoomMapEditor: ({ onZoneCountsConfirmed }: { onZoneCountsConfirmed?: (c: LedSegmentCounts) => void }) => (
    <button type="button" data-testid="confirm-derive" onClick={() => onZoneCountsConfirmed?.(DERIVED)} />
  ),
}));

interface PageProps {
  initialConfig?: LedCalibrationConfig;
  draftCounts?: LedSegmentCounts | null;
  onSaved: (config: LedCalibrationConfig) => void;
  registerLeaveGuard?: (guard: LeaveGuard | null) => void;
}
const pageProps = vi.hoisted(() => ({ current: null as PageProps | null }));

vi.mock("@/features/calibration/ui/CalibrationPage", () => ({
  CalibrationPage: (props: PageProps) => {
    pageProps.current = props;
    return <p data-testid="calibration">{JSON.stringify(props.draftCounts ?? null)}</p>;
  },
}));

import { SettingsLayout } from "../SettingsLayout";

const SAVED: LedCalibrationConfig = {
  counts: { top: 40, right: 20, bottom: 40, left: 20 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 120,
};

function renderAt(section: (typeof SECTION_IDS)[keyof typeof SECTION_IDS]) {
  return renderWithShellStores(<SettingsLayout />, {
    navigation: { uiMode: "full", activeSection: section },
    lighting: { calibration: SAVED, localSink: { transport: "serial", id: "/dev/cu.test" } },
  });
}

describe("room map → LED Setup hand-off", () => {
  beforeEach(() => {
    pageProps.current = null;
    syncStripLedCount.mockClear();
  });

  it("opens LED Setup with the counts as a draft over the saved layout, once", async () => {
    const shell = renderAt(SECTION_IDS.ROOM_MAP);
    fireEvent.click(await screen.findByTestId("confirm-derive"));

    expect(shell.navigationActions.goToSection).toHaveBeenCalledWith(SECTION_IDS.LED_SETUP);

    act(() => shell.navigation.setActiveSection(SECTION_IDS.LED_SETUP));
    expect(await screen.findByTestId("calibration")).toHaveTextContent(JSON.stringify(DERIVED));
    // The saved layout stays the baseline; the counts are not merged into it.
    expect(pageProps.current?.initialConfig).toEqual(SAVED);

    // Consumed: the next visit opens on the saved layout alone.
    act(() => shell.navigation.setActiveSection(SECTION_IDS.LIGHTS));
    act(() => shell.navigation.setActiveSection(SECTION_IDS.LED_SETUP));
    expect(await screen.findByTestId("calibration")).toHaveTextContent("null");
  });

  it("gives LED Setup the shell's leave guard, so a tab click can be held", async () => {
    const shell = renderAt(SECTION_IDS.LED_SETUP);
    await screen.findByTestId("calibration");

    const proceed = vi.fn<() => void>();
    pageProps.current?.registerLeaveGuard?.(() => true);
    shell.navigation.requestLeave(proceed);
    expect(proceed).not.toHaveBeenCalled();
  });

  it("keeps the room map's strip in step with a newly saved LED total", async () => {
    const shell = renderAt(SECTION_IDS.LED_SETUP);
    await screen.findByTestId("calibration");

    act(() => pageProps.current?.onSaved({ ...SAVED, totalLeds: 164 }));

    expect(shell.lightingActions.saveCalibration).toHaveBeenCalled();
    expect(syncStripLedCount).toHaveBeenCalledWith(164, "/dev/cu.test");
  });
});
