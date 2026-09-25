export default {
  title: "Settings",
  subtitle: "Startup, language, updates, help and about",
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
    help: {
      title: "Help",
      sub: "Guide · logs · feedback",
    },
    about: {
      title: "About",
      sub: "Build · license",
    },
    telemetry: {
      sub: "Live throughput",
    },
  },
  help: {
    opensInBrowser: "opens in your browser",
    guide: {
      label: "Setup guide",
      description: "The first-run steps: connect a light, set up the LEDs, turn on Ambilight.",
      action: "Show again",
      shown: "The guide is back at the top of the window",
      alreadyDone: "Every step is already done — there's nothing left to show",
    },
    logs: {
      label: "Log folder",
      description: "LumaSync's log files, for a bug report. They stay on this computer unless you share them.",
      action: "Open folder",
      error: "Couldn't open the log folder",
    },
    issue: {
      label: "Report an issue",
      description:
        "Opens a new GitHub issue in your browser with the app version and system filled in. Nothing is sent until you submit it there.",
      action: "Report",
    },
    discussions: {
      label: "Questions and ideas",
      description: "Ask, suggest or show your setup in GitHub Discussions.",
      action: "Discussions",
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
