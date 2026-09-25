import type { TFunction } from "i18next";

import {
  isOutputsApplied,
  needsCalibration,
  startFailureNotice,
  usbLeftOut,
  type ChoiceAnswer,
} from "@/features/mode/state/modeApplyOutcome";
import { LIGHTING_OUTPUTS_STATUS } from "@/shared/contracts/lightingRuntime";

import { HUE_LEFT_OUT_MESSAGE, HUE_NOT_STARTED_MESSAGE, startFailureMessage } from "./buildShellNotices";

/**
 * One sentence for a lighting choice that fell short, in the shell notices'
 * own copy, for a surface with room for one line: the popup's callout and the
 * OS notification a tray choice raises while the window is hidden. `null` for
 * a choice that ran on everything it named, and for one that was overtaken or
 * cut short by a quit, which nobody needs telling about.
 */
export function choiceFailureMessage(answer: ChoiceAnswer, t: TFunction): string | null {
  const code = answer.status.code;
  if (code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_SUPERSEDED || code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_SHUTTING_DOWN) {
    return null;
  }
  if (needsCalibration(answer)) return t("shell:notices.messages.calibrationRequired");
  const failure = startFailureNotice(answer);
  if (failure) return startFailureMessage(failure, t);
  const { outcome } = answer;
  if (outcome.hueNotStarted) return t(HUE_NOT_STARTED_MESSAGE[outcome.hueNotStarted]);
  if (usbLeftOut(answer)) return t("shell:notices.messages.usbLeftOut");
  if (outcome.hueLeftOut) {
    return t(HUE_LEFT_OUT_MESSAGE[outcome.hueLeftOut], { output: t("common:hotplug.targetLabel.usb") });
  }
  if (isOutputsApplied(answer)) return null;
  return code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_START_FAILED
    ? t("shell:notices.messages.choiceStartFailed")
    : t("shell:notices.messages.choiceRefused");
}
