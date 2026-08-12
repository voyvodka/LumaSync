import type { Catalogue } from "@/features/i18n/catalogue";
import type enTelemetry from "@/locales/en/telemetry";

const telemetry: Catalogue<typeof enTelemetry> = {
  title: "Çalışma telemetrisi",
  description: "Capture/send hızını ve kuyruk baskısını neredeyse gerçek zamanlı izle.",
  metrics: {
    captureFps: "Capture FPS",
    sendFps: "Send FPS",
    queueHealth: "Kuyruk sağlığı",
  },
  queueHealth: {
    healthy: "Sağlıklı",
    warning: "Uyarı",
    critical: "Kritik",
  },
  states: {
    loading: "Telemetri yükleniyor...",
    empty: "Henüz runtime aktivitesi yok.",
    error: "Telemetri şu anda kullanılamıyor.",
  },
  hue: {
    title: "Hue Stream",
    status: "Durum",
    packetRate: "Paket Hızı",
    lastError: "Son Hata",
    reconnects: "Yeniden Bağlanma",
    dtlsCipher: "DTLS Şifrelemesi",
    connectionAge: "Bağlantı Yaşı",
    uptimeFormat: "{{minutes}} dk {{seconds}} sn",
    packetRateFormat: "{{rate}} pkt/s",
    reconnectsFormat: "{{total}} ({{success}} başarılı, {{failed}} başarısız)",
    noError: "—",
    errorAgo: "{{code}} — {{minutes}} dk önce",
  },
};

export default telemetry;
