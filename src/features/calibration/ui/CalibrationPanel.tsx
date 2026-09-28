import { memo } from "react";

import { useLightingActions, useLightingControlState, type LightingControlState } from "@/features/mode/state/lightingControl";
import { syncStripLedCount } from "@/features/device/model/usbStripRoster";
import type { LocalSink } from "@/features/device/localSink";
import type { LedSetupTarget } from "@/features/device/ui/DevicesPage";
import { useLeaveGuardRegistrar } from "@/features/shell/navigationStore";
import { preloadableComponent } from "@/shared/lib/preloadableComponent";
import { normalizeLedCalibrationConfig } from "../model/contracts";
import { readLedSetupSource } from "../state/ledSetupSource";

// Split out: it outweighs the rest of the shell, so the compact window never parses it. See
// docs/architecture/ui-and-shell.md, "Per-window bundles".
const CalibrationPage = preloadableComponent("CalibrationPage", () =>
  import("./CalibrationPage").then((m) => m.CalibrationPage),
);

/** Warms the page's chunk and what it reads first, so even a first visit opens on real values. */
export function preloadCalibrationPanel(): void {
  CalibrationPage.preload();
  void readLedSetupSource().catch((error: unknown) => {
    console.warn("[LumaSync] LED Setup could not read the displays ahead of a visit:", error);
  });
}

const selectCalibration = (state: LightingControlState) => state.calibration;
const selectLocalSink = (state: LightingControlState) => state.localSink;

/** Whether Test on this strip would light it: the output connected now is this strip, or none is and
 *  the test shows only on the screen. */
function testLightsIt(strip: LedSetupTarget["strip"], sink: LocalSink | null): boolean {
  if (sink === null || strip === null) return true;
  const transport = strip.transport;
  if (sink.transport === "serial") return transport?.kind === "serial" && transport.portName === sink.id;
  return transport?.kind === "wled" && transport.sink.ip === sink.id;
}

interface CalibrationPanelProps {
  /** The strip laid out, as Devices knows it. */
  target: LedSetupTarget;
  /** Back to the strip's page, through the leave guard. */
  onBack: () => void;
}

/**
 * LED Setup on one strip, over Devices. The primary strip's layout is the one the lighting reads, so
 * only a save of it reaches the lighting store; Test lights the output connected now, so it is off on
 * a strip that is not that one.
 */
export const CalibrationPanel = memo(function CalibrationPanel({ target, onBack }: CalibrationPanelProps) {
  const calibration = useLightingControlState(selectCalibration);
  const localSink = useLightingControlState(selectLocalSink);
  const { saveCalibration } = useLightingActions();
  const registerLeaveGuard = useLeaveGuardRegistrar();
  const stripId = target.strip?.id;
  return (
    <CalibrationPage.Component
      // Another strip is another draft, not an edit of this one.
      key={stripId ?? "first-strip"}
      stripId={stripId}
      back={{ label: target.name, onBack }}
      testable={testLightsIt(target.strip, localSink)}
      initialConfig={target.primary ? calibration : normalizeLedCalibrationConfig(target.strip?.layout)}
      registerLeaveGuard={registerLeaveGuard}
      onNavigateBack={onBack}
      onSaved={(cfg) => {
        if (target.primary) saveCalibration(cfg);
        // With no port to find it by, the room map falls back to its only strip — the primary's.
        if (!target.primary && target.port === null) return;
        void syncStripLedCount(cfg.totalLeds, target.port).catch((error) => {
          console.error("[LumaSync] Room map strip LED count could not follow the saved layout:", error);
        });
      }}
    />
  );
});
