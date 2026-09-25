export default {
  title: "Settings",
  subtitle: "Startup, language, updates and about",
  groups: {
    startup: {
      title: "Startup",
      sub: "Launch at login",
    },
    language: {
      title: "Language",
      sub: "Interface locale",
    },
    updates: {
      title: "Updates",
      sub: "Version check",
    },
    about: {
      title: "About",
      sub: "Build · license",
    },
    telemetry: {
      sub: "Live throughput",
    },
  },
  language: {
    label: "Interface language",
    description: "Applies to every LumaSync window right away",
  },
  about: {
    tagline: "Screen-synced ambient lighting",
    license: "MIT",
  },
  nav: {
    switchToCompact: "Compact view",
    switchToFull: "Full settings",
    sections: {
      lights: "Lights",
      "led-setup": "LED Setup",
      devices: "Devices",
      system: "Settings",
      "room-map": "Room",
    },
  },
  startupTray: {
    launchAtLogin: "Launch at login",
    launchAtLoginDescription: "Start LumaSync automatically when you log in.",
    readError: "Couldn't read whether LumaSync launches at login",
    writeError: "Couldn't change launch at login — try again",
  },
  nerdStats: {
    label: "Show stats for nerds",
    description: "Show frame rate and live output numbers in the status bar. Off saves a little work.",
  },
};
