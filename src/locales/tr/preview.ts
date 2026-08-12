export default {
  title: "LED önizleme",
  tray: {
    show: "LED Önizlemesini Göster",
  },
  entry: {
    ledSetupButton: "Test ve Önizleme",
    ledSetupHint: "Ekran yakalama olmadan desenleri test etmek için dijital ikiz kaplamasını ve kontrol penceresini açın.",
  },
  control: {
    close: "Kapat",
    closeHint: "LED önizlemesini kapat — test deseni durur ve aydınlatmanız normale döner. LED Kurulumu'ndaki Test ve Önizleme ile yeniden açabilirsiniz.",
    closed: "Önizleme kapatıldı",
    reopenHint: "LED önizlemesi kapatıldı. İstediğiniz zaman LED Kurulumu'ndaki Test ve Önizleme ile veya tepsi menüsünden yeniden açabilirsiniz.",
    dragHint: "Pencereyi taşımak için başlığı sürükleyin.",
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
    LED_TEST_PATTERN_NO_CALIBRATION: "Test deseninin doğru boyutlanması için önce LED şeridinizi kalibre edin.",
    LED_TEST_PATTERN_RUNTIME_ERROR: "Test deseni başlatılamadı. Günlükleri kontrol edip tekrar deneyin.",
    LED_TEST_PATTERN_INVALID_PARAMS: "Test deseni ayarları geçersiz. Rengi veya hızı düzeltip tekrar deneyin.",
    TWIN_OVERLAY_OPEN_FAILED: "İkiz kaplama penceresi açılamadı.",
    TWIN_OVERLAY_DISPLAY_NOT_FOUND: "Seçilen ekran artık kullanılamıyor.",
    TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE: "Canlı ikiz kaplaması bu platformda henüz desteklenmiyor.",
    CONTROL_POPUP_FAILED: "Kontrol penceresi açılamadı.",
  },
};
