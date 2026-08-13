export default {
  title: "Runtime telemetry",
  description: "Watch capture/send throughput and queue pressure in near real-time.",
  metrics: {
    captureFps: "Capture FPS",
    sendFps: "Send FPS",
    queueHealth: "Queue health",
    linkMaxFps: "Link max",
  },
  link: {
    fpsFormat: "{{fps}} fps",
    absent: "—",
    absentTitle: "No serial link in this session",
  },
  queueHealth: {
    healthy: "Healthy",
    warning: "Warning",
    critical: "Critical",
  },
  states: {
    loading: "Loading telemetry...",
    empty: "No runtime activity yet.",
    error: "Telemetry unavailable.",
  },
  hue: {
    title: "Hue Stream",
    status: "Status",
    packetRate: "Packet Rate",
    lastError: "Last Error",
    reconnects: "Reconnects",
    dtlsCipher: "DTLS Cipher",
    connectionAge: "Connection Age",
    uptimeFormat: "{{minutes}} min {{seconds}} sec",
    packetRateFormat: "{{rate}} pkt/s",
    reconnectsFormat: "{{total}} ({{success}} successful, {{failed}} failed)",
    noError: "—",
    errorAgo: "{{code}} — {{minutes}} min ago",
  },
};
