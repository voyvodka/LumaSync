export default {
  title: "General",
  description: "General application settings.",
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
  },
  callout: {
    tone: {
      error: "Error",
      warning: "Warning",
      info: "Note",
      ok: "Done",
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
  },
  hotplug: {
    targetLabel: {
      usb: "USB",
      hue: "Hue",
    },
    // The `usb` target when a WLED panel is what drives it.
    wledLabel: "WLED",
  },
};
