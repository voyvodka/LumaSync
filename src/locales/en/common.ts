export default {
  title: "General",
  description: "General application settings.",
  output: {
    title: "Output targets",
    devices: {
      usb: "USB LED Strip",
      hue: "Philips Hue",
    },
    status: {
      connected: "Connected",
      notConnected: "Not connected",
      ready: "Ready",
      notConfigured: "Not configured",
    },
    noDevices: "No devices available",
    noDevicesHint: "Connect your devices in Settings",
  },
  mode: {
    title: "LED mode",
    description: "Choose output mode and tune static color when needed.",
    options: {
      off: "Off",
      ambilight: "Ambilight",
      solid: "Solid",
    },
    colorModelRgb: "RGB",
    solidColor: "Solid color",
    brightness: "Brightness",
    lockedReasonCalibration: "Complete calibration before enabling LED mode.",
    openCalibration: "Open calibration",
    ambilight: {
      blackBorderTitle: "Black border detection",
      blackBorderDescription: "Automatically detects and skips letterbox / pillarbox bars when sampling screen color.",
      smoothingTitle: "Color transition speed",
      smoothingDescription: "Lower values produce smoother gradients; higher values react faster to screen changes.",
      smoothingSlowLabel: "Smooth",
      smoothingFastLabel: "Instant",
    },
  },
  compact: {
    sections: {
      mode: "Mode",
      scene: "Scene",
    },
    scenes: {
      movie: "Movie",
      game: "Game",
      music: "Music",
      chill: "Chill",
      read: "Read",
    },
    offline: {
      title: "No reachable output",
      body: "Connect a USB LED strip or pair a Hue bridge to enable lighting modes.",
      action: "Open devices",
    },
  },
  ui: {
    colorPicker: {
      rootAriaLabel: "Color picker",
      hueLabel: "Hue",
      svLabel: "Saturation and brightness",
      hexLabel: "HEX",
      hexPlaceholder: "RRGGBB",
      recentColors: "Recent",
      recentItemAriaLabel: "Use {{hex}}",
    },
    onboardingBanner: {
      dismissAriaLabel: "Dismiss hint",
    },
    onboarding: {
      step1: {
        title: "Welcome to LumaSync",
        body: "Pick a lighting mode to get started — Off, Ambilight, or a single solid color.",
        action: "Open lights",
      },
      step2: {
        title: "Connect your lights",
        body: "Connect a USB LED controller, a WLED ESP, or pair a Hue bridge so the modes have somewhere to send frames.",
        action: "Open devices",
      },
      step3: {
        title: "Calibrate your strip",
        body: "Tell LumaSync how many LEDs sit on each screen edge so Ambilight maps colors to the right corners.",
        action: "Open calibration",
      },
    },
  },
  hotplug: {
    usbDisconnected: "USB device disconnected. Continuing with remaining targets.",
    unsupportedFallback: "USB device not recognised — switched to Hue-only mode.",
    stopFailed: "Stop failed for {{targets}}. Output left active — try again.",
    targetLabel: {
      usb: "USB",
      hue: "Hue",
    },
  },
  captureFailed: {
    permission: "Screen recording permission is required. Check it in System Settings › Privacy & Security.",
    display: "The selected display is no longer available. Pick another one in LED Setup.",
    transient: "Screen capture could not start. Try switching the mode off and on.",
    unsupported: "Screen capture is not supported on this platform.",
    output: "No LED output port available.",
    internal: "Screen capture failed ({{reason}}).",
  },
  captureStalled: {
    display: "Screen capture stopped — the display is gone. Pick another one in LED Setup.",
    generic: "Screen capture stopped delivering frames ({{reason}}).",
  },
  captureAction: {
    openSettings: "Open System Settings",
  },
};
