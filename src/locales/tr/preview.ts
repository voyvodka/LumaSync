import type { Catalogue } from "@/features/i18n/catalogue";
import type enPreview from "@/locales/en/preview";

const preview: Catalogue<typeof enPreview> = {
  title: "LED önizleme",
  tray: {
    show: "LED Önizlemesini Göster",
  },
  entry: {
    ledSetupButton: "Test ve Önizleme",
    ledSetupHint: "Ekran yakalama olmadan desenleri test etmek için dijital ikiz kaplamasını ve kontrol penceresini aç.",
  },
  control: {
    close: "Kapat",
    closeHint: "LED önizlemesini kapat — test deseni durur ve aydınlatman normale döner. LED Kurulumu'ndaki Test ve Önizleme ile yeniden açabilirsin.",
    reopenHint: "LED önizlemesi kapatıldı. İstediğin zaman LED Kurulumu'ndaki Test ve Önizleme ile ya da tepsi menüsünden yeniden açabilirsin.",
    dragHint: "Pencereyi taşımak için başlığı sürükle.",
    calibrationRequired: "LED şeridin önce kalibre edilmesi gerekiyor. LED Kurulumu'ndan ayarla, sonra modu yeniden seç.",
    autoStart: {
      stripOnly: "Yalnızca LED şerit test ediliyor. Hue ışıklarını da eklemek için bir desen seç.",
      noStrip: "Bağlı LED şerit yok, bu yüzden desen yalnızca kaplamada görünür. Hue ışıklarını da eklemek için bir desen seç.",
    },
  },
  test: {
    title: "Test deseni",
    run: "Testi başlat",
    running: "Çalışıyor",
    idle: "Durduruldu",
    stop: "Durdur",
    speed: {
      label: "Hız",
      slow: "Yavaş",
      med: "Orta",
      fast: "Hızlı",
    },
  },
  pattern: {
    solid: "Sabit",
    chase: "Takip",
    rainbow: "Gökkuşağı",
    spiral: "Spiral",
    gamut: "Renk gamı",
    channelProbe: "Renk sırası kontrolü",
  },
  twin: {
    scopeTest: "Test",
    scopeLive: "Canlı",
    ariaLabel: "LED şerit dijital ikiz kaplaması",
  },
  live: {
    unavailableLinux: "Canlı ikiz kaplaması Linux'ta henüz kullanılamıyor — bunun yerine test desenleri kullanılıyor.",
  },
  status: {
    test: "Test modu",
    live: "Canlı",
    LED_TEST_PATTERN_PREVIEW_ONLY: "Yalnızca önizleme — cihaz bağlı olmadığından desen yalnızca kaplamada görünür.",
    LED_TEST_PATTERN_NO_CALIBRATION: "Test deseninin doğru boyutlanması için önce LED şeridini kalibre et.",
    LED_TEST_PATTERN_RUNTIME_ERROR: "Test deseni başlatılamadı. Günlükleri kontrol edip tekrar dene.",
    LED_TEST_PATTERN_INVALID_PARAMS: "Test deseni ayarları geçersiz. Rengi ya da hızı düzeltip tekrar dene.",
    TWIN_OVERLAY_OPEN_FAILED: "İkiz kaplama penceresi açılamadı.",
    TWIN_OVERLAY_DISPLAY_NOT_FOUND: "Seçilen ekran artık kullanılamıyor.",
    TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE: "Canlı ikiz kaplaması bu platformda henüz desteklenmiyor.",
    CONTROL_POPUP_FAILED: "Kontrol penceresi açılamadı.",
  },
};

export default preview;
