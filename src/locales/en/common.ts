export default {
  hintFor: "About {{label}}",
  opensInBrowser: "opens in your browser",
  mode: {
    title: "LED mode",
    options: {
      off: "Off",
      ambilight: "Ambilight",
      solid: "Solid",
      effect: "Effect",
    },
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
