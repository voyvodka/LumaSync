export default {
  title: "Settings",
  hintFor: "About {{label}}",
  pages: {
    general: "General",
    appearance: "Appearance",
    updates: "Updates",
    help: "Help",
    about: "About",
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
    diagnostics: {
      label: "Diagnostics",
      description:
        "Copies the app version, your system and what is connected, for a bug report. No addresses, device ids or keys, and nothing is sent.",
      action: "Copy",
      copied: "Copied",
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
    shortcuts: {
      label: "Keyboard shortcuts",
      zoomIn: "Make the interface larger",
      zoomOut: "Make the interface smaller",
      zoomReset: "Interface at normal size",
    },
  },
  language: {
    label: "Interface language",
  },
  about: {
    tagline: "Screen-synced ambient lighting",
    local: "Everything runs on this computer. Nothing is sent anywhere.",
    copyVersion: "Copy version",
    copied: "Copied",
    site: "Website",
    source: "Source",
    notes: "Release notes",
    license: "MIT licence",
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
    readError: "Couldn't read whether LumaSync launches at login",
    writeError: "Couldn't change launch at login — try again",
  },
  launchLights: {
    label: "Lights on launch",
    hint: "What the lights do when LumaSync starts, at login included.",
    resume: "Resume last mode",
    off: "Stay off",
  },
  closeAction: {
    label: "Close button",
    hint: "What closing the window does. Running in the background keeps its icon in the menu bar (the notification area on Windows); quitting stops the lights.",
    tray: "Keep running",
    quit: "Quit",
  },
  notifications: {
    label: "Notifications",
    hint: "System notifications, such as a choice from the icon's menu that failed while the window was hidden.",
  },
  uiZoom: {
    label: "Interface size",
    hint: "Scales the main window and the control popup. The compact window grows with it; the full window only when it would be too small. ⌘/Ctrl and + − 0 change it too.",
    p90: "90%",
    p100: "100%",
    p110: "110%",
    p125: "125%",
  },
  motion: {
    label: "Reduce motion",
    hint: "Turns animations down in every LumaSync window. Off, your system's setting applies.",
  },
  nerdStats: {
    label: "Show stats for nerds",
    description: "Show frame rate and live output numbers in the status bar. Off saves a little work.",
  },
};
