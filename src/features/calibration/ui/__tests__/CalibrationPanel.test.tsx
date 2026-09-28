import { cleanup, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { LedStrip } from "@/shared/contracts/strips";
import { renderWithShellStores } from "@/test/shellProviders";

const pageProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("../CalibrationPage", () => ({
  CalibrationPage: (props: Record<string, unknown>) => {
    pageProps.current = props;
    return <p data-testid="calibration-page" />;
  },
}));
const syncStripLedCount = vi.hoisted(() => vi.fn<(total: number, port: string | null) => Promise<void>>(async () => {}));
vi.mock("@/features/device/model/usbStripRoster", () => ({ syncStripLedCount }));

import { CalibrationPanel } from "../CalibrationPanel";

const layout = (side: number) =>
  ({
    templateId: "monitor-27-16-9",
    counts: { top: side, right: side, bottom: side, left: side },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "subtle",
    startAnchor: "top-start",
    direction: "cw",
    totalLeds: side * 4,
  }) as LedCalibrationConfig;
const SAVED = layout(15);
const OTHER = layout(10);
const strip = (id: string, layout?: LedCalibrationConfig) =>
  ({ id, enabled: true, transport: { kind: "serial", portName: `/dev/${id}` }, hardware: {}, layout }) as LedStrip;

async function renderPanel(
  target: Parameters<typeof CalibrationPanel>[0]["target"],
  localSink: { transport: "serial" | "wled"; id: string } | null = { transport: "serial", id: "/dev/a" },
) {
  const onBack = vi.fn<() => void>();
  const shell = renderWithShellStores(<CalibrationPanel target={target} onBack={onBack} />, {
    lighting: { calibration: SAVED, localSink },
  });
  await screen.findByTestId("calibration-page");
  return { onBack, shell, props: () => pageProps.current! };
}

describe("CalibrationPanel", () => {
  beforeEach(() => {
    pageProps.current = null;
    syncStripLedCount.mockClear();
  });

  it("on the strip the lighting reads: its saved layout in, a save out to the lighting, and Test on", async () => {
    const { shell, props, onBack } = await renderPanel({ strip: strip("a", SAVED), name: "Desk", primary: true, port: "/dev/a" });

    expect(props()).toMatchObject({ stripId: "a", testable: true, initialConfig: SAVED, back: { label: "Desk" } });
    (props().onSaved as (cfg: LedCalibrationConfig) => void)(OTHER);
    expect(shell.lightingActions.saveCalibration).toHaveBeenCalledWith(OTHER);
    expect(syncStripLedCount).toHaveBeenCalledWith(40, "/dev/a");
    (props().back as { onBack: () => void }).onBack();
    expect(onBack).toHaveBeenCalledOnce();
  });

  // The lighting reads the primary strip: another strip's layout is saved for it, and Test would
  // light the driven strip with a layout that is not its own.
  it("on another strip: its own layout in, the lighting left alone, and no Test", async () => {
    const { shell, props } = await renderPanel({ strip: strip("b", OTHER), name: "Shelf", primary: false, port: "/dev/b" });

    expect(props()).toMatchObject({ stripId: "b", testable: false });
    expect(props().initialConfig).toMatchObject({ totalLeds: 40 });
    (props().onSaved as (cfg: LedCalibrationConfig) => void)(OTHER);
    expect(shell.lightingActions.saveCalibration).not.toHaveBeenCalled();
    expect(syncStripLedCount).toHaveBeenCalledWith(40, "/dev/b");
  });

  // The room map finds a strip by its port, else takes its only one — the primary's. A WLED strip
  // laid out from its own page has no port, and must not rewrite the USB strip's count.
  it("a strip with no port that is not the primary leaves the room map alone", async () => {
    const wled = { id: "w", enabled: true, transport: { kind: "wled" }, hardware: {} } as unknown as LedStrip;
    const { props } = await renderPanel({ strip: wled, name: "WLED", primary: false, port: null });
    (props().onSaved as (cfg: LedCalibrationConfig) => void)(OTHER);
    expect(syncStripLedCount).not.toHaveBeenCalled();
  });

  // Test lights the output connected now: on the strip that is that output, whichever is primary.
  it("offers Test on the strip that is connected now, and on any while none is", async () => {
    const wledStrip = {
      id: "w",
      enabled: true,
      transport: { kind: "wled", sink: { ip: "10.0.0.5", port: 4048, ledCount: 60, protocol: "ddp" } },
      hardware: {},
    } as unknown as LedStrip;
    const target = { strip: wledStrip, name: "WLED", primary: true, port: null };

    await renderPanel(target, { transport: "wled", id: "10.0.0.5" });
    expect(pageProps.current).toMatchObject({ testable: true });
    cleanup();
    await renderPanel(target, { transport: "serial", id: "/dev/a" });
    expect(pageProps.current).toMatchObject({ testable: false });
    cleanup();
    await renderPanel(target, null);
    expect(pageProps.current).toMatchObject({ testable: true });
  });

  // No strip saved yet: the first layout makes one, and is what the lighting will read.
  it("with no strip yet, lays out the first one and saves it to the lighting", async () => {
    const { shell, props } = await renderPanel({ strip: null, name: "Devices", primary: true, port: null }, null);
    expect(props()).toMatchObject({ stripId: undefined, testable: true, initialConfig: SAVED });
    (props().onSaved as (cfg: LedCalibrationConfig) => void)(OTHER);
    expect(shell.lightingActions.saveCalibration).toHaveBeenCalledWith(OTHER);
  });
});
