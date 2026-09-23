import type { Catalogue } from "@/features/i18n/catalogue";
import type enShell from "@/locales/en/shell";

const shell: Catalogue<typeof enShell> = {
  keybind: {
    modeOff: "Işıkları kapat",
    modeAmbilight: "Ambilight moduna geç",
    modeSolid: "Tek renk moduna geç",
    openSettings: "Ayarları aç",
  },
  errorBoundary: {
    title: "Bir şeyler ters gitti",
    body: "Hatayı kaydettik. Log'ları görüntüle, uygulamayı yeniden başlat veya detayları destek için kopyala.",
    showLogs: "Log'ları görüntüle",
    restart: "Yeniden başlat",
    copyError: "Hatayı kopyala",
    showDetails: "Detayları göster",
    hideDetails: "Detayları gizle",
  },
  fpsHud: {
    title: "FPS",
    inactive: "Ambilight kapalı",
    lowFps: "Düşük FPS",
    latencyUnit: "ms",
    ariaLabel: "Oluşturma performansı: saniye başına {{fps}} kare, {{latency}} milisaniye gecikme",
  },
  statusBar: {
    kbdMode: "mod",
    kbdSettings: "ayarlar",
    state: {
      ok: "TAMAM",
      off: "KAPALI",
      idle: "BOŞTA",
      streaming: "YAYIN",
      retrying: "DENİYOR",
      failed: "BAŞARISIZ",
      waiting: "BEKLİYOR",
      leftOut: "DIŞARIDA",
    },
    reconnect: {
      usbAriaLabel: "USB cihazını yeniden bağla",
      hueAriaLabel: "Hue köprüsünü yeniden bağla",
    },
  },
  titleBar: {
    minimize: "Simge durumuna küçült",
    maximize: "Ekranı kapla",
    restore: "Geri yükle",
    close: "Kapat",
    sectionsAriaLabel: "Bölümler",
  },
  notices: {
    regionLabel: "Bildirimler",
    severity: {
      error: "Hata",
      warning: "Uyarı",
      info: "Bilgi",
    },
    dismiss: "Bildirimi kapat",
    showDetails: "Ayrıntıları göster",
    showLess: "Daha az göster",
    showMore_one: "{{count}} bildirim daha göster",
    showMore_other: "{{count}} bildirim daha göster",
    moreBadge: "+{{count}}",
    moreCount: "+{{count}} daha",
    titles: {
      capturePermission: "Ekran kaydı engelli",
      captureStalled: "Ekran yakalama durdu",
      startFailed: "Aydınlatma başlamadı",
      stopFailed: "Çıkış durmadı",
      previewOpenFailed: "LED önizlemesi açılmadı",
      hueUnreachable: "Hue köprüsüne ulaşılamıyor",
      hueAuth: "Hue yeniden eşleştirilmeli",
      hueConfig: "Hue kurulmamış",
      hueWaiting: "Hue köprüsü bekleniyor",
      hueBusy: "Hue köprüsü meşgul",
      usbDisconnected: "USB şerit çıkarıldı",
      usbUnsupported: "USB cihazı tanınmadı",
      hueColor: "Hue rengi uygulanmadı",
    },
    actions: {
      devices: "Cihazlar",
      ledSetup: "LED kurulumu",
      stopHue: "Hue'yu durdur",
    },
  },
};

export default shell;
