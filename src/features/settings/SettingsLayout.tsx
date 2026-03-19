import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SECTION_IDS, SECTION_ORDER, type SectionId } from "../../shared/contracts/shell";
import { GeneralSection } from "./sections/GeneralSection";
import { StartupTraySection } from "./sections/StartupTraySection";
import { LanguageSection } from "./sections/LanguageSection";
import { AboutLogsSection } from "./sections/AboutLogsSection";
import { DeviceSection } from "./sections/DeviceSection";
import { CalibrationSection } from "./sections/CalibrationSection";
import type { LedCalibrationConfig } from "../calibration/model/contracts";

interface SectionMeta {
  id: SectionId;
  label: string;
  marker: string;
}

function SectionContent({
  sectionId,
  calibration,
  onOpenCalibration,
}: {
  sectionId: SectionId;
  calibration?: LedCalibrationConfig;
  onOpenCalibration: () => void;
}) {
  switch (sectionId) {
    case SECTION_IDS.GENERAL:
      return <GeneralSection />;
    case SECTION_IDS.STARTUP_TRAY:
      return <StartupTraySection />;
    case SECTION_IDS.LANGUAGE:
      return <LanguageSection />;
    case SECTION_IDS.ABOUT_LOGS:
      return <AboutLogsSection />;
    case SECTION_IDS.DEVICE:
      return <DeviceSection />;
    case SECTION_IDS.CALIBRATION:
      return <CalibrationSection calibration={calibration} onEdit={onOpenCalibration} />;
    default:
      return <GeneralSection />;
  }
}

interface SettingsLayoutProps {
  activeSection: SectionId;
  onSectionChange: (sectionId: SectionId) => void;
  calibration?: LedCalibrationConfig;
  onOpenCalibration: () => void;
}

export function SettingsLayout({
  activeSection,
  onSectionChange,
  calibration,
  onOpenCalibration,
}: SettingsLayoutProps) {
  const { t } = useTranslation("common");

  const sectionMeta = useMemo<Record<SectionId, SectionMeta>>(
    () => ({
      [SECTION_IDS.GENERAL]: {
        id: SECTION_IDS.GENERAL,
        label: t("settings.sections.general"),
        marker: "GE",
      },
      [SECTION_IDS.STARTUP_TRAY]: {
        id: SECTION_IDS.STARTUP_TRAY,
        label: t("settings.sections.startupTray"),
        marker: "ST",
      },
      [SECTION_IDS.LANGUAGE]: {
        id: SECTION_IDS.LANGUAGE,
        label: t("settings.sections.language"),
        marker: "LG",
      },
      [SECTION_IDS.ABOUT_LOGS]: {
        id: SECTION_IDS.ABOUT_LOGS,
        label: t("settings.sections.aboutLogs"),
        marker: "AB",
      },
      [SECTION_IDS.DEVICE]: {
        id: SECTION_IDS.DEVICE,
        label: t("settings.sections.device"),
        marker: "DV",
      },
      [SECTION_IDS.CALIBRATION]: {
        id: SECTION_IDS.CALIBRATION,
        label: t("settings.sections.calibration"),
        marker: "CL",
      },
    }),
    [t],
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-100/60 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <nav
        className="flex w-56 min-w-44 flex-col border-r border-slate-300/60 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80"
        aria-label="Settings navigation"
      >
        <div className="border-b border-slate-300/70 px-4 py-4 dark:border-zinc-800">
          <span className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-zinc-400">
            LumaSync
          </span>
        </div>

        <ul className="flex flex-1 flex-col gap-1 p-2" role="list">
          {SECTION_ORDER.map((sectionId) => {
            const meta = sectionMeta[sectionId];
            const isActive = sectionId === activeSection;
            return (
              <li key={sectionId}>
                <button
                  className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? "bg-slate-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-slate-600 hover:bg-slate-200/70 hover:text-slate-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  }`}
                  onClick={() => onSectionChange(sectionId)}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span
                    className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tracking-wide ${
                      isActive
                        ? "bg-white/20 text-white dark:bg-zinc-900/20 dark:text-zinc-900"
                        : "bg-slate-300/60 text-slate-700 dark:bg-zinc-700 dark:text-zinc-100"
                    }`}
                    aria-hidden="true"
                  >
                    {meta.marker}
                  </span>
                  <span>{meta.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-6 sm:px-10 sm:py-8" role="main">
        <SectionContent
          sectionId={activeSection}
          calibration={calibration}
          onOpenCalibration={onOpenCalibration}
        />
      </main>
    </div>
  );
}
