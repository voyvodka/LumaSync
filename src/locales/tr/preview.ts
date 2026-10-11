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
    calibrationRequired: "LED şeridin önce kalibre edilmesi gerekiyor. LED Kurulumu'ndan ayarla, sonra modu yeniden seç.",
  },
  twin: {
    ariaLabel: "LED şerit dijital ikiz kaplaması",
  },
  status: {
    PREVIEW_OPEN_FAILED: "Önizleme açılamadı.",
    PREVIEW_CLOSE_FAILED: "Bir önizleme penceresi kapatılamadı.",
  },
};

export default preview;
