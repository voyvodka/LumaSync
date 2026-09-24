import { useEffect, useRef, useState } from "react";

import { connectionEvents as defaultConnectionEvents, type ConnectionEventBus } from "@/features/device/connectionEvents";

import { shouldPromptLedSetupOnConnection } from "./entryFlow";

/** Session-scoped, so a WebView reload does not prompt again for the same connect. */
export const LED_SETUP_PROMPTED_KEY = "lumasync_led_setup_prompted";

export interface LedSetupPromptInput {
  /** The persisted calibration has been read; before that, "none saved" is a guess. */
  ready: boolean;
  connected: boolean;
  hasCalibration: boolean;
  /** LED Setup is on view: the step is being taken. */
  onLedSetup: boolean;
  /** Where a user-initiated connect is announced; tests pass their own. */
  connectionEvents?: ConnectionEventBus;
}

/**
 * The port of the connect the user made this session with no saved LED layout,
 * while that is still the next step — or `null`. It feeds a notice and never
 * moves the user: the first connect used to jump straight to LED Setup, past
 * the chip type and colour order the user had not set yet.
 *
 * Only a connect the user asked for counts. Watching `connected` flip also
 * caught the boot auto-reconnect, so a user without a layout was nudged on
 * every launch.
 */
export function useLedSetupPrompt({
  ready,
  connected,
  hasCalibration,
  onLedSetup,
  connectionEvents = defaultConnectionEvents,
}: LedSetupPromptInput): string | null {
  const [promptedPort, setPromptedPort] = useState<string | null>(null);
  const promptedRef = useRef(sessionStorage.getItem(LED_SETUP_PROMPTED_KEY) === "1");
  // Read by the bus listener, which is subscribed once.
  const latest = useRef({ ready, hasCalibration });
  useEffect(() => {
    latest.current = { ready, hasCalibration };
  }, [ready, hasCalibration]);

  useEffect(
    () =>
      connectionEvents.subscribe((event) => {
        if (!event.connected) return;
        const prompt =
          latest.current.ready &&
          shouldPromptLedSetupOnConnection({
            userInitiated: event.userInitiated === true,
            hasCalibration: latest.current.hasCalibration,
            alreadyPrompted: promptedRef.current,
          });
        if (!prompt) return;
        promptedRef.current = true;
        sessionStorage.setItem(LED_SETUP_PROMPTED_KEY, "1");
        setPromptedPort(event.portName);
      }),
    [connectionEvents],
  );

  // Opening LED Setup is the step taken; the prompt does not come back after it.
  useEffect(() => {
    if (onLedSetup) setPromptedPort(null);
  }, [onLedSetup]);

  if (!connected || hasCalibration || onLedSetup) return null;
  return promptedPort;
}
