import type { Catalogue } from "@/features/i18n/catalogue";
import type enTelemetry from "@/locales/en/telemetry";

const telemetry: Catalogue<typeof enTelemetry> = {
  capture: "Ekran yakalama",
  send: "Şeride gönderim",
  queue: "Gönderim kuyruğu",
  linkLimit: "Bağlantı sınırı",
  hueStream: "Hue akışı",
  huePackets: "Hue paketleri",
  hueLastError: "Son Hue hatası",
  hueReconnects: "Hue yeniden bağlanma",
  fps: "{{fps}} fps",
  packetRate: "saniyede {{rate}}",
  uptimeMinutes: "{{minutes}} dk",
  uptimeSeconds: "{{seconds}} sn",
  reconnectsFailed: "{{total}} · {{failed}} başarısız",
  notRunning: "Çalışmıyor",
  none: "Yok",
  unmeasured: "Ölçülmedi",
  error: "Değerler okunamadı",
  queueHealth: {
    healthy: "Sağlıklı",
    warning: "Geride kalıyor",
    critical: "Aşırı yüklü",
  },
  errorAgo: "{{message}} — {{minutes}} dk önce",
  errorJustNow: "{{message}} — az önce",
};

export default telemetry;
