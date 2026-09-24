export default {
  title: "LED preview",
  tray: {
    show: "Show LED Preview",
  },
  entry: {
    ledSetupButton: "Test & Preview",
    ledSetupHint: "Open the digital-twin overlay and control popup to test patterns without screen capture.",
  },
  control: {
    close: "Close",
    closeHint: "Close the LED preview — the test pattern stops and your lighting returns to normal. Reopen it with Test & Preview in LED Setup.",
    reopenHint: "LED preview closed. Reopen it any time with Test & Preview in LED Setup, or from the tray menu.",
    dragHint: "Drag the header to move this popup.",
    calibrationRequired: "The LED strip needs a calibration first. Set it up in LED Setup, then pick the mode again.",
    autoStart: {
      stripOnly: "Testing the LED strip only. Pick a pattern to include your Hue lights.",
      noStrip: "No LED strip is connected, so the pattern shows in the overlay only. Pick a pattern to include your Hue lights.",
    },
  },
  test: {
    title: "Test pattern",
    run: "Run test",
    running: "Running",
    idle: "Stopped",
    stop: "Stop",
    speed: {
      label: "Speed",
      slow: "Slow",
      med: "Medium",
      fast: "Fast",
    },
  },
  pattern: {
    solid: "Solid",
    chase: "Chase",
    rainbow: "Rainbow",
    spiral: "Spiral",
    gamut: "Gamut",
    channelProbe: "Color order check",
  },
  twin: {
    scopeTest: "Test",
    scopeLive: "Live",
    ariaLabel: "LED strip digital-twin overlay",
  },
  live: {
    unavailableLinux: "Live twin overlay is not available on Linux yet — using test patterns instead.",
  },
  status: {
    test: "Test mode",
    live: "Live",
    LED_TEST_PATTERN_PREVIEW_ONLY: "Preview only — no device is connected, so the pattern shows in the overlay only.",
    LED_TEST_PATTERN_NO_CALIBRATION: "Calibrate your LED strip first so the test pattern can be sized correctly.",
    LED_TEST_PATTERN_RUNTIME_ERROR: "The test pattern could not start. Check the logs and try again.",
    LED_TEST_PATTERN_INVALID_PARAMS: "The test pattern settings are invalid. Adjust the colour or speed and retry.",
    TWIN_OVERLAY_OPEN_FAILED: "The twin overlay window could not open.",
    TWIN_OVERLAY_DISPLAY_NOT_FOUND: "The selected display is no longer available.",
    TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE: "Live twin overlay is not supported on this platform yet.",
    CONTROL_POPUP_FAILED: "The control popup could not open.",
  },
};
