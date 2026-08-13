import type { Catalogue } from "@/features/i18n/catalogue";
import type enLights from "@/locales/en/lights";

const lights: Catalogue<typeof enLights> = {
  slab: {
    modeText: "Aydınlatma",
    modeAccent: "Modu",
    signalText: "Kenar sinyali",
    signalAccent: "· canlı · mod ayarları",
    scenesText: "Sahne",
    scenesAccent: "ön ayarları",
  },
  mode: {
    off: {
      title: "Kapalı",
      subtitle: "Çıkışlar beklemede",
    },
    ambilight: {
      title: "Ambilight",
      subtitle: "Ekran 1 · {{count}} LED",
      subtitleFallback: "Canlı ekran yakalama",
    },
    solid: {
      title: "Sabit",
      subtitle: "{{hex}} · %{{brightness}}",
    },
  },
  signal: {
    title: "Yakalama → Şerit",
    delta: "Δ",
    fps: "Σ",
    edgesAria: "Canlı kenar önizlemesi",
    linkBudget: {
      constrained: "USB bağlantı sınırı — 115.200 baud hızında bu şerit yaklaşık {{fps}} fps taşıyabiliyor.",
      hint: "Daha akıcı bir efekt için şeridi kısaltın, iki denetleyiciye bölün ya da çıkışı WLED üzerinden verin.",
    },
    edges: {
      top: "ÜST · {{count}}",
      bot: "ALT · {{count}}",
      left: "SOL · {{count}}",
      right: "SAĞ · {{count}}",
    },
    display: {
      label: "EKRAN {{index}}",
      sub: "—",
    },
    profile: {
      brightness: "Parlaklık",
      saturation: "Doygunluk",
      blackBorder: "Siyah kenar",
      blackBorderAuto: "oto",
      blackBorderOff: "kapalı",
    },
    smoothing: {
      title: "Işık yanıtlama hızı",
      description: "Işıkların ekran değişikliklerini ne kadar hızlı takip edeceğini belirler — LED strip ve Hue ışıkları için geçerli.",
      subtle: "Yumuşak",
      moderate: "Dengeli",
      intense: "Yoğun",
    },
  },
  dock: {
    outputs: "Çıkışlar",
    addAria: "Çıkış ekle",
    addTooltip: "Yakında — çoklu Hue alanı",
    addHueZoneTooltip: "Yeni bir Hue bölgesi ekle",
    addDisabledTooltip: "Bölge eklemek için bir Hue köprüsü eşleyin",
    hintTitle: "Oda alanı",
    hintBody: "Telemetri / mini oda\nönizlemesi / kısayollar\niçin yer tutucu",
    rows: {
      usbName: "USB",
      usbType: "CH340",
      usbSub: "{{count}} LED · <b>seri</b>",
      usbSubUnavailable: "Şerit bağlı değil",
      hueName: "HUE",
      hueType: "ENTERTAINMENT",
      hueSubStreaming: "Köprü · <b>DTLS 50hz</b>",
      hueSubIdle: "Köprü · <b>bekleme</b>",
      hueSubUnavailable: "Yapılandırılmadı",
    },
  },
  calibrationBanner: {
    title: "Kalibrasyon gerekli",
    sub: "Bu modu etkinleştirmeden önce LED düzenini tamamlayın.",
    action: "Kurulumu aç",
  },
  led: {
    colorCorrection: {
      title: "Renk Duzeltme",
      description: "Cikis oncesi kanal basina renk duzeltmesi.",
      gammaR: "Gamma Kirmizi",
      gammaG: "Gamma Yesil",
      gammaB: "Gamma Mavi",
      kelvin: "Beyaz Nokta (K)",
      saturation: "Doygunluk",
      reset: "Varsayilanlara sifirla",
      kelvinHint: "Dusuk = sicak, yuksek = soguk",
    },
    chipType: {
      label: "LED Chip Tipi",
      description: "SK6812 RGBW seritler daha temiz beyazlar icin ayri bir beyaz LED icerir.",
      options: {
        ws2812b: "WS2812B (3 bayt RGB)",
        sk6812rgbw: "SK6812 RGBW (4 bayt)",
      },
      sk6812AdalightWarning: "SK6812 RGBW, Adalight profili ile desteklenmez. WS2812B kodlamasina donuluyor.",
    },
    firmwareProfile: {
      title: "Firmware Profili",
      description: "LED kontrolcu firmware'inizle uyumlu seri protokolu secin.",
      lumasyncV1Label: "LumaSync v1",
      lumasyncV1Description: "Saglik kontrolu ve telemetri iceren LumaSync yerel protokolu.",
      adalightLabel: "Adalight",
      adalightDescription: "Prismatik, Hyperion, Boblight ve cogu DIY Arduino sketch ile uyumlu.",
      brightnessDisabledTooltip: "Adalight profili: parlaklik firmware tarafindan kontrol edilir",
      mismatchTooltip: "Firmware {{advertised}} bildiriyor; {{attempted}} secmek sessiz bir sekilde gormezden gelinecek. Firmware'i guncelleyin veya dikkatli sekilde gecersiz kilin.",
      advertisedBadge: "Algilanan: {{advertised}}",
      useAnywayLabel: "Yine de kullan",
      useAnywayHint: "Firmware'in algiladigi profili gecersiz kilar. Yalnizca ozel firmware kullaniyorsaniz etkinlestirin.",
      overrideWarningTitle: "Uyumsuz firmware profili",
      overrideWarningBody: "Kontrolcunuz son saglik kontrolunde {{advertised}} bildirdi, ancak {{attempted}} secmek uzeresiniz. USB seridi sessizce hicbir sey yapmayacak; Hue ise akmaya devam edecek. Yalnizca firmware'inizin {{attempted}} kablo formatini anladigindan eminseniz devam edin.",
      overrideWarningConfirm: "Yine de {{attempted}} kullan",
      overrideWarningCancel: "Vazgec",
      overrideWarningDontAskAgain: "Bir daha sorma",
    },
  },
};

export default lights;
