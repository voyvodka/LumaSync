import type { Catalogue } from "@/features/i18n/catalogue";
import type enCommon from "@/locales/en/common";

const common: Catalogue<typeof enCommon> = {
  title: "Genel",
  description: "Genel uygulama ayarları.",
  output: {
    offline: {
      title: "Ulaşılabilir çıkış yok",
      body: "Aydınlatma modlarını etkinleştirmek için bir USB LED şerit bağla veya Hue köprüsünü eşleştir.",
      action: "Cihazları aç",
      stoppedBody: "LumaSync Hue köprüsünü kontrol etmeyi bıraktı — bu ağda yanıt vermedi.",
      retry: "Yeniden dene",
      retrying: "Kontrol ediliyor…",
    },
    checking: "Çıkışlar kontrol ediliyor…",
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
    usbDisconnectedLightingOff: "USB cihazının bağlantısı kesildi, aydınlatma kapandı. Devam etmek için şeridi yeniden bağlayıp bir mod seçin.",
    unsupportedFallback: "USB cihazı tanınmıyor — yalnızca Hue ile devam ediliyor.",
    unsupportedNoFallback: "USB cihazı tanınmıyor ve kurulu başka bir çıkış yok. Cihazlar'dan desteklenen bir denetleyici bağlayın.",
    stopFailed: "{{targets}} durdurulamadı; çıkış hâlâ etkin.",
    stopFailedUsbHint: "Şeridi durdurmak için modu Kapalı'ya alın.",
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
    internalNoReason: "Ekran yakalama başarısız.",
  },
  captureStalled: {
    display: "Ekran yakalama durdu — ekran kayboldu. LED Kurulumu'ndan başka birini seçin.",
    generic: "Ekran yakalama kare göndermeyi durdurdu ({{reason}}).",
    genericNoReason: "Ekran yakalama kare göndermeyi durdurdu.",
  },
  captureAction: {
    openSettings: "Sistem Ayarları",
  },
  hueLeftOut: {
    unreachable: "Hue köprüsüne ulaşılamıyor — şimdilik yalnızca USB ile çalışıyor. Köprü geri geldiğinde Hue'yu yeniden açın.",
    auth: "Hue yeniden eşleştirilmeli — şimdilik yalnızca USB ile çalışıyor. Cihazlar'dan tekrar eşleştirin.",
    config: "Hue kurulmamış — şimdilik yalnızca USB ile çalışıyor.",
    busy: "Hue köprüsü önceki bir oturumu hâlâ tutuyor — şimdilik yalnızca USB ile çalışıyor. Köprü bıraktığı anda Hue kendiliğinden katılacak.",
    busyGaveUp: "Hue köprüsü başka bir oturumla meşgul kaldı — yalnızca USB ile çalışıyor. Köprü boşalınca Hue'yu yeniden açın.",
  },
  hueBootRetry: {
    waiting: "Hue köprüsü önceki bir oturumu hâlâ tutuyor. Köprü bıraktığı anda aydınlatma kendiliğinden devam edecek.",
    gaveUp: "Hue köprüsü başka bir oturumla meşgul kaldı, bu yüzden aydınlatma kapalı. Köprü boşalınca yeniden açın.",
  },
};

export default common;
