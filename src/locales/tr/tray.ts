import type { Catalogue } from "@/features/i18n/catalogue";
import type enTray from "@/locales/en/tray";

const tray: Catalogue<typeof enTray> = {
  openSettings: "Ayarları Aç",
  lightsOff: "Işıkları Kapat",
  resumeLastMode: "Son Modda Aç",
  solidColor: "Sabit Renk",
  quit: "LumaSync'ten Çık",
  hint: {
    title: "LumaSync menü çubuğunda çalışıyor",
    body: "Pencereyi geri açmak için menü çubuğundaki simgeye tıkla. Bu mesaj sadece ilk kapatmada görünür.",
  },
};

export default tray;
