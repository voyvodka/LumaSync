import type { Catalogue } from "@/features/i18n/catalogue";
import type enTray from "@/locales/en/tray";

const tray: Catalogue<typeof enTray> = {
  openSettings: "LumaSync'i Aç",
  lightsOff: "Işıklar Kapalı",
  ambilight: "Ambilight",
  solidColor: "Sabit Renk",
  closeOverlays: "Kaplamaları Kapat",
  quit: "LumaSync'ten Çık",
  outcomeTitle: "Tepsiden ışık seçimi",
  status: {
    off: "○ Işıklar kapalı",
    running: "● {{mode}} · {{outputs}}",
    runningNoOutputs: "● {{mode}}",
  },
  hint: {
    title: "LumaSync sistem tepsisinde çalışıyor",
    body: "Pencereyi geri açmak için sistem tepsisindeki simgeye tıkla. Bu mesaj sadece ilk kapatmada görünür.",
  },
};

export default tray;
