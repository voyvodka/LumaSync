export default {
  title: "LED preview",
  tray: {
    show: "Show LED Preview",
  },
  control: {
    close: "Close",
    closeHint: "Close the LED preview. Reopen it from Lights or the tray menu.",
    hide: "Hide",
    hideHint: "Hide these controls and keep the preview open. Bring them back from the tray menu.",
    twinHide: "Hide the on-screen LEDs",
    twinShow: "Show the on-screen LEDs",
    twinHeld: "The on-screen LEDs are hidden while Ambilight captures the screen.",
    calibrationRequired: "The LED strip needs a calibration first. Set it up in LED Setup, then pick the mode again.",
  },
  twin: {
    ariaLabel: "LED strip digital-twin overlay",
  },
  scenes: {
    label: "Test scenes",
    names: {
      edgeTour: "Edge tour",
      spiral: "Spiral",
      sunset: "Sunset",
      colorFields: "Colour fields",
      letterbox: "Letterbox",
    },
    stop: "Stop {{name}}",
    ownsLights: "Modes are locked while a scene plays.",
  },
  status: {
    PREVIEW_OPEN_FAILED: "The preview could not open.",
    PREVIEW_CLOSE_FAILED: "A preview window could not be closed.",
    PREVIEW_SCENE_NO_OUTPUT: "Nothing to light: connect a strip or WLED panel, or start Hue first.",
    PREVIEW_SCENE_CAPTURE_DENIED: "Screen recording is off, so Ambilight cannot see the scene.",
    PREVIEW_SCENE_START_FAILED: "The scene could not start. Your lights are as they were.",
    PREVIEW_SCENE_TEST_PATTERN_ACTIVE: "A test is running in LED Setup or Devices. Stop it first.",
    PREVIEW_DISPLAY_NOT_FOUND: "The display the preview is on is gone.",
    PREVIEW_RESTORE_FAILED: "Your lights could not go back to their mode.",
  },
};
