import type { Catalogue } from "@/features/i18n/catalogue";
import type enSettings from "@/locales/en/settings";

const settings: Catalogue<typeof enSettings> = {
  title: "Genel",
  subtitle: "Başlangıç davranışı ve dil",
  groups: {
    startup: {
      title: "Başlangıç",
      sub: "Başlat · tepsi",
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
    description: "Değişiklik için yeniden başlatma gerekir",
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
  },
};

export default settings;
