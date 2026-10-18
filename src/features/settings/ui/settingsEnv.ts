import type { SetupGuideRestartResult } from "@/features/onboarding/state/setupGuideControl";
import type { UpdaterState } from "@/features/updater/useAutoUpdater";

/** What the shell hands the Settings page; every custom row receives all of it. */
export interface SettingsEnv {
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
  /** When a check the user asked for last found nothing newer. */
  upToDateAt?: number | null;
  /** When any update check last got an answer; `null` until the first. */
  lastCheckedAt?: number | null;
  devSetUpdaterState?: (state: UpdaterState) => void;
  localOutputConnected: boolean;
  /** The app owns a Hue session, which has telemetry of its own. */
  hueActive?: boolean;
  /** Absent outside the shell, where there is no guide to bring back. */
  onRestartSetupGuide?: () => SetupGuideRestartResult;
  /** The install's state as text for a bug report, read when called. Absent outside the shell. */
  readDiagnostics?: () => string;
}
