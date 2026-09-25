import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { outputsResult } from "@/test/lightingRuntime";

import { choiceFailureMessage } from "../choiceFailureMessage";

const t = ((key: string) => key) as unknown as TFunction;

describe("choiceFailureMessage", () => {
  it("names the reason in the shell notices' own copy", () => {
    expect(choiceFailureMessage(outputsResult("OUTPUTS_CALIBRATION_REQUIRED"), t)).toBe(
      "shell:notices.messages.calibrationRequired",
    );
    expect(
      choiceFailureMessage(
        outputsResult("OUTPUTS_START_FAILED", undefined, {
          applyStatus: {
            code: "AMBILIGHT_MODE_START_FAILED",
            message: "",
            details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
          },
        }),
        t,
      ),
    ).toBe("shell:notices.messages.capturePermission");
    expect(choiceFailureMessage(outputsResult("OUTPUTS_REFUSED", undefined, { hueNotStarted: "auth" }), t)).toBe(
      "shell:notices.messages.hueNotStarted.auth",
    );
    expect(
      choiceFailureMessage(outputsResult("OUTPUTS_APPLIED_PARTIAL", undefined, { hueLeftOut: "unreachable" }), t),
    ).toBe("shell:notices.messages.hueLeftOut.unreachable");
    expect(
      choiceFailureMessage(outputsResult("OUTPUTS_APPLIED_PARTIAL", undefined, { droppedTargets: ["usb"] }), t),
    ).toBe("shell:notices.messages.usbLeftOut");
  });

  it("falls back to what happened when no reason is named", () => {
    expect(choiceFailureMessage(outputsResult("OUTPUTS_REFUSED"), t)).toBe("shell:notices.messages.choiceRefused");
    expect(choiceFailureMessage(outputsResult("OUTPUTS_START_FAILED"), t)).toBe(
      "shell:notices.messages.choiceStartFailed",
    );
  });

  it("has nothing to say about a choice that ran, was overtaken or met a quit", () => {
    expect(choiceFailureMessage(outputsResult("OUTPUTS_APPLIED"), t)).toBeNull();
    expect(choiceFailureMessage(outputsResult("OUTPUTS_SUPERSEDED"), t)).toBeNull();
    expect(choiceFailureMessage(outputsResult("OUTPUTS_SHUTTING_DOWN"), t)).toBeNull();
  });
});
