import type { Catalogue } from "@/features/i18n/catalogue";
import type enSettings from "@/locales/en/settings";

const settings: Catalogue<typeof enSettings> = {
  title: "Ayarlar",
  hintFor: "{{label}} hakkında",
  pages: {
    general: "Genel",
    appearance: "Görünüm",
    updates: "Güncellemeler",
    help: "Yardım",
    about: "Hakkında",
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
    shortcuts: {
      label: "Klavye kısayolları",
      zoomIn: "Arayüzü büyüt",
      zoomOut: "Arayüzü küçült",
      zoomReset: "Arayüz normal boyutta",
    },
  },
  language: {
    label: "Arayüz dili",
  },
  about: {
    tagline: "Ekran senkronlu ortam aydınlatması",
    local: "Her şey bu bilgisayarda çalışır. Hiçbir veri gönderilmez.",
    copyVersion: "Sürümü kopyala",
    copied: "Kopyalandı",
    site: "Site",
    source: "Kaynak kod",
    notes: "Sürüm notları",
    license: "MIT lisansı",
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
    readError: "LumaSync'in girişte başlayıp başlamadığı okunamadı",
    writeError: "Girişte başlatma değiştirilemedi — tekrar dene",
  },
  launchLights: {
    label: "Açılışta ışıklar",
    hint: "LumaSync başladığında, girişte başlama dahil, ışıkların ne yapacağı.",
    resume: "Son modu sürdür",
    off: "Kapalı başla",
  },
  closeAction: {
    label: "Kapat düğmesi",
    hint: "Pencereyi kapatınca ne olacağı. Arka planda çalışırken simgesi menü çubuğunda (Windows'ta bildirim alanında) durur; çıkmak ışıkları durdurur.",
    tray: "Arka planda çalış",
    quit: "Çık",
  },
  notifications: {
    label: "Bildirimler",
    hint: "Sistem bildirimleri; örneğin pencere gizliyken simge menüsünden yapılan bir seçim başarısız olduğunda.",
  },
  uiZoom: {
    label: "Arayüz boyutu",
    hint: "Ana pencereyi ve kontrol penceresini ölçekler. Kompakt pencere onunla büyür; tam pencere yalnızca fazla küçük kalırsa. ⌘/Ctrl ile + − 0 da değiştirir.",
    p90: "%90",
    p100: "%100",
    p110: "%110",
    p125: "%125",
  },
  motion: {
    label: "Hareketi azalt",
    hint: "Tüm LumaSync pencerelerinde animasyonları azaltır. Kapalıyken sisteminin ayarı geçerli olur.",
  },
  nerdStats: {
    label: "Meraklısı için istatistikler",
    description: "Durum çubuğunda kare hızını ve canlı çıkış değerlerini gösterir. Kapalıyken uygulama biraz daha az iş yapar.",
  },
};

export default settings;
