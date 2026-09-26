export default {
  available: {
    title: "LumaSync {{version}} is ready",
  },
  downloading: {
    title: "Downloading LumaSync {{version}}",
    progressLabel: "Download progress",
    amount: "{{done}} of {{total}}",
    left: "{{time}} left",
  },
  installing: {
    title: "Installing LumaSync {{version}}",
    body: "LumaSync relaunches when it's done.",
  },
  error: {
    title: "Couldn't install the update",
    body: "You can keep using this version.",
    checkTitle: "Couldn't check for updates",
    checkBody: "Nothing changed. Usually there's no connection, or the network blocks the request.",
    details: "Details",
  },
  eta: {
    seconds: "{{seconds}} s",
    minutes: "{{minutes}} min {{seconds}} s",
  },
  actions: {
    later: "Later",
    install: "Install and relaunch",
    close: "Close",
    retry: "Try again",
  },
  noteKind: {
    add: "Added",
    change: "Changed",
    fix: "Fixed",
  },
  statusItem: {
    label: "Update {{version}}",
    short: "Update",
    aria: "LumaSync {{version}} is ready — show the update",
  },
  checkAction: "Check now",
  betaChannel: "Beta channel",
  betaChannelDescription:
    "Get prereleases as well as stable versions. On by default while you run a prerelease.",
  betaConfirm: {
    text: "Prereleases are tested less, and the .msi and .deb installers are never run before release.",
    confirm: "Switch to beta",
    cancel: "Cancel",
  },
  checking: "Checking…",
  upToDate: "You're on the latest version · checked {{time}}",
  upToDateShort: "Up to date",
};
