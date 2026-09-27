import { memo } from "react";

import { useLightingActions, useLightingControlState, type LightingControlState } from "@/features/mode/state/lightingControl";
import { syncStripLedCount } from "@/features/device/model/usbStripRoster";
import { useLeaveGuardRegistrar, useNavigationActions } from "@/features/shell/navigationStore";
import { SECTION_IDS } from "@/shared/contracts/shell";
import { preloadableComponent } from "@/shared/lib/preloadableComponent";
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
const selectSerialPort = (state: LightingControlState) =>
  state.localSink?.transport === "serial" ? state.localSink.id || null : null;

/** LED Setup as a shell section: the saved layout in, a saved one out to the lighting store. */
export const CalibrationPanel = memo(function CalibrationPanel() {
  const calibration = useLightingControlState(selectCalibration);
  const serialPort = useLightingControlState(selectSerialPort);
  const { saveCalibration } = useLightingActions();
  const { goToSection } = useNavigationActions();
  const registerLeaveGuard = useLeaveGuardRegistrar();
  return (
    <CalibrationPage.Component
      initialConfig={calibration}
      registerLeaveGuard={registerLeaveGuard}
      onNavigateBack={() => {
        void goToSection(SECTION_IDS.LIGHTS);
      }}
      onSaved={(cfg) => {
        saveCalibration(cfg);
        void syncStripLedCount(cfg.totalLeds, serialPort).catch((error) => {
          console.error("[LumaSync] Room map strip LED count could not follow the saved layout:", error);
        });
      }}
    />
  );
});
