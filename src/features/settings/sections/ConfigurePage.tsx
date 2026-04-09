import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalibrationPage } from "../../calibration/ui/CalibrationPage";
import { RoomMapEditor } from "./RoomMapEditor";
import type { LedCalibrationConfig, LedSegmentCounts } from "../../calibration/model/contracts";
import type { CalibrationOverlayStep } from "../../calibration/state/entryFlow";

type ConfigureTab = "led-layout" | "room-map";

interface ConfigurePageProps {
  calibration?: LedCalibrationConfig;
  calibrationStep: CalibrationOverlayStep;
  onCalibrationSaved: (config: LedCalibrationConfig) => void;
  onCalibrationStepChange: (step: CalibrationOverlayStep) => void;
  onZoneCountsConfirmed: (counts: LedSegmentCounts) => void;
}

export function ConfigurePage({
  calibration,
  calibrationStep,
  onCalibrationSaved,
  onCalibrationStepChange,
  onZoneCountsConfirmed,
}: ConfigurePageProps) {
  const { t } = useTranslation("common");
  const [activeTab, setActiveTab] = useState<ConfigureTab>("led-layout");

  const tabs: { id: ConfigureTab; label: string }[] = [
    { id: "led-layout", label: t("configure.tabs.ledLayout") },
    { id: "room-map", label: t("configure.tabs.roomMap") },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div
        className="flex shrink-0 items-center gap-1 px-4 pt-4"
        style={{ borderBottom: "1px solid var(--border-card)" }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="relative px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none"
              style={{
                color: isActive ? "var(--color-cyan)" : "var(--text-secondary)",
                borderBottom: isActive
                  ? "2px solid var(--color-cyan)"
                  : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "led-layout" && (
          <CalibrationPage
            key="calibration-page"
            initialStep={calibrationStep}
            initialConfig={calibration}
            onNavigateBack={() => {}}
            onSaved={onCalibrationSaved}
            onStepChange={onCalibrationStepChange}
          />
        )}
        {activeTab === "room-map" && (
          <RoomMapEditor onZoneCountsConfirmed={onZoneCountsConfirmed} />
        )}
      </div>
    </div>
  );
}
