import type { Catalogue } from "@/features/i18n/catalogue";
import type enPreview from "@/locales/en/preview";

const preview: Catalogue<typeof enPreview> = {
  title: "LED önizlemesi",
  tray: {
    show: "LED Önizlemesini Göster",
  },
  control: {
    close: "Kapat",
    closeHint: "LED önizlemesini kapat. Işıklar'dan ya da tepsi menüsünden yeniden açabilirsin.",
    hide: "Gizle",
    hideHint: "Bu kontrolleri gizle, önizleme açık kalsın. Tepsi menüsünden geri getirebilirsin.",
    twinHide: "Ekrandaki LED'leri gizle",
    twinShow: "Ekrandaki LED'leri göster",
    twinHeld: "Ambilight ekranı yakalarken ekrandaki LED'ler gizli.",
    calibrationRequired: "LED şerit henüz kurulmadı. LED kurulumundan ayarla, sonra modu yeniden seç.",
  },
  twin: {
    ariaLabel: "LED şerit dijital ikiz kaplaması",
  },
  scenes: {
    label: "Test sahneleri",
    names: {
      edgeTour: "Kenar turu",
      spiral: "Spiral",
      sunset: "Gün batımı",
      colorFields: "Renk alanları",
      letterbox: "Sinema bantları",
      latency: "Gecikme",
    },
    stop: "{{name}} sahnesini durdur",
  },
  latency: {
    label: "İşlem gecikmesi",
    about: "İşlem gecikmesi hakkında",
    info: "Bir karenin yakalandığı andan renklerinin ışık çıkışına verildiği ana kadar geçen süre; son geçişlerin ortancası. Ekranın ve ışıkların kendi gecikmeleri ile 50 ms'de bir gönderen Hue akışı dahil değil.",
    measuring: "Ölçülüyor…",
    unseen: "Henüz hiçbir geçiş ışıklara ulaşmadı",
    value: "{{ms}} ms",
  },
  status: {
    PREVIEW_OPEN_FAILED: "Önizleme açılamadı.",
    PREVIEW_CLOSE_FAILED: "Bir önizleme penceresi kapatılamadı.",
    PREVIEW_SCENE_NO_OUTPUT: "Yakacak bir şey yok: bir şerit ya da WLED paneli bağla veya önce Hue'yu başlat.",
    PREVIEW_SCENE_CAPTURE_DENIED: "Ekran kaydı kapalı, bu yüzden Ambilight sahneyi göremiyor.",
    PREVIEW_SCENE_START_FAILED: "Sahne başlatılamadı. Işıkların olduğu gibi.",
    PREVIEW_SCENE_TEST_PATTERN_ACTIVE: "LED Kurulumu'nda ya da Cihazlar'da bir test çalışıyor. Önce onu durdur.",
    PREVIEW_DISPLAY_NOT_FOUND: "Önizlemenin açık olduğu ekran artık yok.",
    PREVIEW_RESTORE_FAILED: "Işıkların önceki moduna dönemedi.",
  },
};

export default preview;
