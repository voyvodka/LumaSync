import type { Catalogue } from "@/features/i18n/catalogue";
import type enSettings from "@/locales/en/settings";

const settings: Catalogue<typeof enSettings> = {
  title: "Ayarlar",
  subtitle: "Başlangıç, dil, güncellemeler, yardım ve hakkında",
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
    help: {
      title: "Yardım",
      sub: "Rehber · kayıtlar · geri bildirim",
    },
    about: {
      title: "Hakkında",
      sub: "Sürüm · lisans",
    },
    telemetry: {
      sub: "Canlı akış",
    },
  },
  help: {
    opensInBrowser: "tarayıcında açılır",
    guide: {
      label: "Kurulum rehberi",
      description: "İlk çalıştırma adımları: bir ışık bağla, LED'leri ayarla, Ambilight'ı aç.",
      action: "Yeniden göster",
      shown: "Rehber pencerenin üstünde yeniden açıldı",
      alreadyDone: "Tüm adımlar zaten tamam — gösterilecek bir şey kalmadı",
    },
    logs: {
      label: "Kayıt klasörü",
      description: "Hata bildirimi için LumaSync'in kayıt dosyaları. Sen paylaşmadıkça bu bilgisayarda kalırlar.",
      action: "Klasörü aç",
      error: "Kayıt klasörü açılamadı",
    },
    issue: {
      label: "Sorun bildir",
      description:
        "Tarayıcında, uygulama sürümü ve sistem bilgisi doldurulmuş yeni bir GitHub kaydı açar. Sen orada gönderene kadar hiçbir şey gönderilmez.",
      action: "Bildir",
    },
    discussions: {
      label: "Sorular ve fikirler",
      description: "GitHub Discussions'ta soru sor, öneride bulun ya da kurulumunu paylaş.",
      action: "Forum",
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
    launchAtLoginDescription: "Oturum açtığında LumaSync'i kendiliğinden başlat.",
    readError: "LumaSync'in girişte başlayıp başlamadığı okunamadı",
    writeError: "Girişte başlatma değiştirilemedi — tekrar dene",
  },
  nerdStats: {
    label: "Meraklısı için istatistikler",
    description: "Durum çubuğunda kare hızını ve canlı çıkış değerlerini gösterir. Kapalıyken uygulama biraz daha az iş yapar.",
  },
};

export default settings;
