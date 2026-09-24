import type { Catalogue } from "@/features/i18n/catalogue";
import type enSettings from "@/locales/en/settings";

const settings: Catalogue<typeof enSettings> = {
  title: "Ayarlar",
  subtitle: "Başlangıç, dil, güncellemeler ve hakkında",
  groups: {
    startup: {
      title: "Başlangıç",
      sub: "Girişte başlatma",
    },
    language: {
      title: "Dil",
      sub: "Arayüz yerelleştirmesi",
    },
    updates: {
      title: "Güncellemeler",
      sub: "Sürüm kontrolü",
    },
    about: {
      title: "Hakkında",
      sub: "Build · lisans",
    },
    telemetry: {
      sub: "Canlı akış",
    },
  },
  language: {
    label: "Arayüz dili",
    description: "Tüm LumaSync pencerelerinde hemen uygulanır",
  },
  about: {
    tagline: "Ekran senkronlu ortam aydınlatması",
    license: "MIT",
  },
  nav: {
    switchToCompact: "Kompakt görünüm",
    switchToFull: "Tam ayarlar",
    sections: {
      lights: "Işıklar",
      "led-setup": "LED Kurulumu",
      devices: "Cihazlar",
      system: "Ayarlar",
      "room-map": "Oda",
    },
  },
  startupTray: {
    launchAtLogin: "Girişte başlat",
    launchAtLoginDescription: "LumaSync'i oturum açtığınızda otomatik başlatın.",
    readError: "LumaSync'in girişte başlayıp başlamadığı okunamadı",
    writeError: "Girişte başlatma değiştirilemedi — tekrar dene",
  },
  nerdStats: {
    label: "Meraklısı için istatistikler",
    description: "Durum çubuğunda kare hızını ve canlı çıkış değerlerini gösterir. Kapalıyken uygulama biraz daha az iş yapar.",
  },
};

export default settings;
