import type { Catalogue } from "@/features/i18n/catalogue";
import type enUpdater from "@/locales/en/updater";

const updater: Catalogue<typeof enUpdater> = {
  available: {
    title: "LumaSync {{version}} hazır",
  },
  downloading: {
    title: "LumaSync {{version}} indiriliyor",
    progressLabel: "İndirme ilerlemesi",
    amount: "{{done}} / {{total}}",
    left: "{{time}} kaldı",
  },
  installing: {
    title: "LumaSync {{version}} kuruluyor",
    body: "Bitince LumaSync yeniden açılacak.",
  },
  error: {
    title: "Güncelleme kurulamadı",
    body: "Bu sürümü kullanmaya devam edebilirsin.",
    checkTitle: "Güncellemeler kontrol edilemedi",
    checkBody: "Hiçbir şey değişmedi. Genelde bağlantı yoktur ya da ağ isteği engelliyordur.",
    details: "Ayrıntılar",
  },
  eta: {
    seconds: "{{seconds}} sn",
    minutes: "{{minutes}} dk {{seconds}} sn",
  },
  actions: {
    later: "Sonra",
    install: "Kur ve yeniden aç",
    close: "Kapat",
    retry: "Tekrar dene",
  },
  noteKind: {
    add: "Eklenenler",
    change: "Değişenler",
    fix: "Düzeltilenler",
  },
  statusItem: {
    label: "Güncelleme {{version}}",
    short: "Güncelleme",
    aria: "LumaSync {{version}} hazır — güncellemeyi göster",
  },
  checkAction: "Kontrol et",
  betaChannel: "Beta kanalı",
  betaChannelDescription:
    "Kararlı sürümlerin yanında ön sürümleri de al. Ön sürüm kullanırken varsayılan olarak açıktır.",
  betaConfirm: {
    text: "Ön sürümler daha az test edilir; .msi ve .deb kurulum dosyaları yayından önce hiç çalıştırılmaz.",
    confirm: "Beta'ya geç",
    cancel: "Vazgeç",
  },
  checking: "Kontrol ediliyor…",
  upToDate: "En son sürümü kullanıyorsun · {{time}} itibarıyla",
  upToDateShort: "Güncel",
  lastChecked: "Son kontrol {{time}}",
};

export default updater;
