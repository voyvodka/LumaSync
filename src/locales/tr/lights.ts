import type { Catalogue } from "@/features/i18n/catalogue";
import type enLights from "@/locales/en/lights";

const lights: Catalogue<typeof enLights> = {
  slab: {
    modeText: "Aydınlatma",
    modeAccent: "Modu",
    modeSettingsText: "Mod",
    modeSettingsAccent: "ayarları",
    scenesText: "Sahne",
    scenesAccent: "ön ayarları",
  },
  mode: {
    off: {
      title: "Kapalı",
      subtitle: "Işıklar kapalı",
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
    effect: {
      title: "Efekt",
      subtitle: "{{name}} · %{{brightness}}",
    },
  },
  effect: {
    label: "Efekt",
    speed: "Hız",
    brightness: "Parlaklık",
    names: {
      rainbow: "Gökkuşağı",
      breathe: "Nefes",
      cycle: "Renk döngüsü",
    },
  },
  signal: {
    linkBudget: {
      constrained: "USB bağlantı sınırı — 115.200 baud hızında bu şerit yaklaşık {{fps}} fps taşıyabiliyor.",
      hint: "Daha akıcı bir efekt için şeridi kısalt, iki denetleyiciye böl ya da çıkışı WLED üzerinden ver.",
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
      subtle: "Yumuşak",
      moderate: "Dengeli",
      intense: "Yoğun",
    },
  },
  dock: {
    outputs: "Çıkışlar",
    addAria: "Çıkış ekle",
    addHueZoneTooltip: "Yeni bir Hue bölgesi ekle",
    addDisabledTooltip: "Bölge eklemek için bir Hue Bridge eşle",
    rows: {
      usbName: "USB",
      usbType: "CH340",
      usbSub: "{{count}} LED · <b>seri</b>",
      usbSubUnavailable: "Şerit bağlı değil",
      wledName: "WLED",
      wledSub: "{{count}} LED · <b>UDP</b>",
      hueName: "HUE",
      hueType: "EĞLENCE",
      hueSubStreaming: "Hue Bridge · <b>DTLS {{hz}} Hz</b>",
      hueSubIdle: "Hue Bridge · <b>bekleme</b>",
      hueSubReconnecting: "Hue Bridge · <b>yeniden bağlanıyor</b>",
      hueSubFailed: "Hue Bridge · <b>yayın durdu</b>",
      hueSubUnavailable: "Yapılandırılmadı",
      hueSubKeyRejected: "Hue Bridge · <b>yeniden eşleştirme gerekli</b>",
      hueSubUnreachable: "Hue Bridge · <b>ulaşılamıyor</b>",
      hueSubChecking: "Hue Bridge · <b>kontrol ediliyor…</b>",
    },
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
      sk6812AdalightWarning: "SK6812 RGBW, Adalight profili ile desteklenmez. WS2812B kodlamasına dönülüyor.",
      firmwareExpectsRgb: "Bağlı denetleyici LED başına 3 bayt bekliyor. WS2812B'yi seç ya da RGBW sürümünü yükle.",
      firmwareExpectsRgbw: "Bağlı denetleyici LED başına 4 bayt bekliyor. SK6812 RGBW'yi seç ya da RGB sürümünü yükle.",
    },
    colorOrder: {
      currentAria: "Geçerli renk sırası: {{order}}",
      identify: {
        button: "Belirle",
        title: "Renk sırasını belirle",
        step: "Adım {{current}}/{{total}}",
        prompt: "Şerit hangi renkte yanıyor?",
        answer: {
          red: "Kırmızı",
          green: "Yeşil",
          blue: "Mavi",
          other: "Başka renk / kapalı",
        },
        otherHint: "Şeridin saf kırmızı, yeşil ya da mavi yanması gerekir. Başka bir renk ya da beyaz gördüysen veya hiç ışık yoksa önce LED çip tipini ve firmware profilini kontrol et, sonra yeniden dene.",
        duplicate: "{{color}} rengini önceki bir adımda zaten seçtin. Her adımda farklı bir renk yanar, tekrar bak.",
        result: "Şeridin için doğru sıra: {{order}}.",
        apply: "{{order}} olarak kaydet",
        cancel: "Vazgeç",
        verify: "{{order}} kaydedildi. Renkler şimdi doğru görünüyor mu?",
        verifyHint: "Bir aydınlatma modu açıkken kontrol et: düz kırmızı, kırmızı görünmeli.",
        keep: "Doğru görünüyor",
        undo: "Geri al ({{order}} sırasına dön)",
        retry: "Yeniden dene",
        close: "Kapat",
        errors: {
          notSending: "Test bir şeride değil, yalnızca önizlemeye ulaştı. Şeridi bağlayıp yeniden dene.",
          noCalibration: "Önce LED Kurulumu'nda LED'lerini ayarla, sonra yeniden dene.",
          startFailed: "Test başlatılamadı. Hiçbir şey değişmedi.",
          saveFailed: "Renk sırası kaydedilemedi. Hiçbir şey değişmedi.",
          stopFailed: "Renk sırası kaydedildi ama test hâlâ çalışıyor olabilir. Tamamlamak için yeniden dene.",
        },
      },
    },
    firmwareProfile: {
      title: "Firmware profili",
      lumasyncV1Label: "LumaSync v1",
      adalightLabel: "Adalight",
      brightnessDisabledTooltip: "Adalight profili: parlaklık firmware tarafından kontrol edilir",
    },
  },
};

export default lights;
