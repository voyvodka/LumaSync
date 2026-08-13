import type { Catalogue } from "@/features/i18n/catalogue";
import type enCommon from "@/locales/en/common";

const common: Catalogue<typeof enCommon> = {
  title: "Genel",
  description: "Genel uygulama ayarları.",
  output: {
    title: "Çıkış hedefleri",
    devices: {
      usb: "USB LED Şerit",
      hue: "Philips Hue",
    },
    status: {
      connected: "Bağlı",
      notConnected: "Bağlı değil",
      ready: "Hazır",
      notConfigured: "Yapılandırılmadı",
    },
    noDevices: "Kullanılabilir cihaz yok",
    noDevicesHint: "Ayarlar'dan cihazlarını bağla",
  },
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
    lockedReasonCalibration: "LED modunu etkinleştirmeden önce kalibrasyonu tamamlayın.",
    openCalibration: "Kalibrasyonu aç",
    ambilight: {
      blackBorderTitle: "Siyah kenar algılama",
      blackBorderDescription: "Ekran rengi örneklenirken letterbox / pillarbox siyah bantları otomatik olarak atlar.",
      smoothingTitle: "Renk geçiş hızı",
      smoothingDescription: "Düşük değerler daha yumuşak geçişler üretir; yüksek değerler ekran değişimlerine daha hızlı tepki verir.",
      smoothingSlowLabel: "Yumuşak",
      smoothingFastLabel: "Anlık",
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
    offline: {
      title: "Ulaşılabilir çıkış yok",
      body: "Aydınlatma modlarını etkinleştirmek için bir USB LED şerit bağla veya Hue köprüsünü eşleştir.",
      action: "Cihazları aç",
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
    onboardingBanner: {
      dismissAriaLabel: "İpucunu kapat",
    },
    onboarding: {
      step1: {
        title: "LumaSync'e hoş geldin",
        body: "Başlamak için bir aydınlatma modu seç — Kapalı, Ambilight ya da tek bir sabit renk.",
        action: "Işıkları aç",
      },
      step2: {
        title: "Işıklarını bağla",
        body: "Modların kareleri gönderebilmesi için bir USB LED denetleyicisi, WLED ESP ya da Hue köprüsü bağla.",
        action: "Cihazları aç",
      },
      step3: {
        title: "Şeridini kalibre et",
        body: "Ambilight'ın renkleri doğru köşelere eşlemesi için her ekran kenarında kaç LED olduğunu LumaSync'e bildir.",
        action: "Kalibrasyonu aç",
      },
    },
  },
  hotplug: {
    usbDisconnected: "USB cihazı bağlantısı kesildi. Kalan hedeflerle devam ediliyor.",
    unsupportedFallback: "USB cihazı tanınmıyor — Hue-only moda alındı.",
    stopFailed: "{{targets}} durdurulamadı. Çıkış etkin bırakıldı; yeniden deneyin.",
    targetLabel: {
      usb: "USB",
      hue: "Hue",
    },
  },
  captureFailed: {
    permission: "Ekran kaydı izni gerekli. Sistem Ayarları › Gizlilik ve Güvenlik bölümünden kontrol edin.",
    display: "Seçili ekran artık kullanılamıyor. LED Kurulumu'ndan başka birini seçin.",
    transient: "Ekran yakalama başlatılamadı. Modu kapatıp açmayı deneyin.",
    unsupported: "Ekran yakalama bu platformda desteklenmiyor.",
    output: "Kullanılabilir LED çıkış portu yok.",
    internal: "Ekran yakalama başarısız ({{reason}}).",
  },
};

export default common;
