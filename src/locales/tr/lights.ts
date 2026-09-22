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
    titleHue: "Yakalama → Hue",
    delta: "Δ",
    fps: "Σ",
    latencyFormat: "{{ms}} ms",
    fpsFormat: "{{fps}} fps",
    packetRateFormat: "{{rate}} pkt/s",
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
    rows: {
      usbName: "USB",
      usbType: "CH340",
      usbSub: "{{count}} LED · <b>seri</b>",
      usbSubUnavailable: "Şerit bağlı değil",
      wledName: "WLED",
      wledSub: "{{count}} LED · <b>UDP</b>",
      hueName: "HUE",
      hueType: "EĞLENCE",
      hueSubStreaming: "Köprü · <b>DTLS {{hz}} Hz</b>",
      hueSubIdle: "Köprü · <b>bekleme</b>",
      hueSubReconnecting: "Köprü · <b>yeniden bağlanıyor</b>",
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
      title: "Renk Düzeltme",
      description: "Çıkış öncesi kanal başına renk düzeltmesi.",
      gammaR: "Gamma Kırmızı",
      gammaG: "Gamma Yeşil",
      gammaB: "Gamma Mavi",
      kelvin: "Beyaz Nokta (K)",
      saturation: "Doygunluk",
      reset: "Varsayılanlara sıfırla",
      kelvinHint: "Düşük = sıcak, yüksek = soğuk",
    },
    chipType: {
      label: "LED Çip Tipi",
      description: "SK6812 RGBW şeritler daha temiz beyazlar için ayrı bir beyaz LED içerir.",
      options: {
        ws2812b: "WS2812B (3 bayt RGB)",
        sk6812rgbw: "SK6812 RGBW (4 bayt)",
      },
      details: {
        ws2812b: "WS2812B · GRB · piksel başına 3 bayt",
        sk6812rgbw: "SK6812 · RGBW · piksel başına 4 bayt · W=min(R,G,B)",
      },
      sk6812AdalightWarning: "SK6812 RGBW, Adalight profili ile desteklenmez. WS2812B kodlamasına dönülüyor.",
    },
    firmwareProfile: {
      title: "Firmware Profili",
      description: "LED kontrolcünüzün firmware'iyle uyumlu seri protokolü seçin.",
      lumasyncV1Label: "LumaSync v1",
      lumasyncV1Description: "Sağlık kontrolü ve telemetri içeren LumaSync yerel protokolü.",
      adalightLabel: "Adalight",
      adalightDescription: "Prismatik, Hyperion, Boblight ve çoğu DIY Arduino sketch'i ile uyumlu.",
      brightnessDisabledTooltip: "Adalight profili: parlaklık firmware tarafından kontrol edilir",
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
