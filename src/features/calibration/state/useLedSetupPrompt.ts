import { useEffect, useRef, useState } from "react";

import { shouldPromptLedSetupOnConnection } from "./entryFlow";

/** Session-scoped, so a WebView reload does not prompt again for the same connect. */
export const LED_SETUP_PROMPTED_KEY = "lumasync_led_setup_prompted";

export interface LedSetupPromptInput {
  /** The persisted calibration has been read; before that, "none saved" is a guess. */
  ready: boolean;
  connected: boolean;
  connectedPort: string | null;
  hasCalibration: boolean;
  /** LED Setup is on view: the step is being taken. */
  onLedSetup: boolean;
}

/**
 * The port whose first connect this session found no saved LED layout, while
 * that is still the next step — or `null`. It feeds a notice and never moves
 * the user: the first connect used to jump straight to LED Setup, past the
 * chip type and colour order the user had not set yet.
 */
export function useLedSetupPrompt({
  ready,
  connected,
  connectedPort,
  hasCalibration,
  onLedSetup,
}: LedSetupPromptInput): string | null {
  const [promptedPort, setPromptedPort] = useState<string | null>(null);
  const wasConnectedRef = useRef(false);
  const promptedRef = useRef(sessionStorage.getItem(LED_SETUP_PROMPTED_KEY) === "1");

  useEffect(() => {
    const prompt =
      ready &&
      shouldPromptLedSetupOnConnection({
        connected,
        wasConnected: wasConnectedRef.current,
        hasCalibration,
        alreadyPrompted: promptedRef.current,
      });
    if (prompt) {
      promptedRef.current = true;
      sessionStorage.setItem(LED_SETUP_PROMPTED_KEY, "1");
      setPromptedPort(connectedPort);
    }
    wasConnectedRef.current = connected;
  }, [ready, connected, connectedPort, hasCalibration]);

  // Opening LED Setup is the step taken; the prompt does not come back after it.
  useEffect(() => {
    if (onLedSetup) setPromptedPort(null);
  }, [onLedSetup]);

  if (!connected || hasCalibration || onLedSetup) return null;
  return promptedPort;
}
