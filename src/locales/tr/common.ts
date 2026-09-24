import type { Catalogue } from "@/features/i18n/catalogue";
import type enCommon from "@/locales/en/common";

const common: Catalogue<typeof enCommon> = {
  title: "Genel",
  description: "Genel uygulama ayarları.",
  mode: {
    title: "LED modu",
    description: "Çıkış modunu seç ve gerektiğinde sabit rengi ayarla.",
    options: {
      off: "Kapalı",
      ambilight: "Ambilight",
      solid: "Sabit",
    },
    colorModelRgb: "RGB",
    solidColor: "Sabit renk",
    brightness: "Parlaklık",
  },
  callout: {
    tone: {
      error: "Hata",
      warning: "Uyarı",
      info: "Bilgi",
      ok: "Tamam",
    },
  },
  compact: {
    sections: {
      mode: "Mod",
      scene: "Sahne",
    },
    scenes: {
      movie: "Film",
      game: "Oyun",
      music: "Müzik",
      chill: "Sakin",
      read: "Okuma",
    },
  },
  ui: {
    colorPicker: {
      rootAriaLabel: "Renk seçici",
      hueLabel: "Renk tonu",
      svLabel: "Doygunluk ve parlaklık",
      hexLabel: "HEX",
      hexPlaceholder: "RRGGBB",
      recentColors: "Son kullanılanlar",
      recentItemAriaLabel: "{{hex}} rengini kullan",
    },
  },
  hotplug: {
    targetLabel: {
      usb: "USB",
      hue: "Hue",
    },
    wledLabel: "WLED",
  },
};

export default common;
