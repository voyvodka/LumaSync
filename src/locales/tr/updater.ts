import type { Catalogue } from "@/features/i18n/catalogue";
import type enUpdater from "@/locales/en/updater";

const updater: Catalogue<typeof enUpdater> = {
  available: {
    eyebrow: "Güncelleme hazır",
    title: "Yeni bir sürüm var",
    body: "LumaSync <b>v{{version}}</b> hazır. Şimdi kurarsan LumaSync yeni sürümle yeniden başlar.",
  },
  downloading: {
    eyebrow: "İndiriliyor",
    title: "v{{version}} hazırlanıyor",
    body: "İmza doğrulaması ile indirme sürüyor — tamamlanınca otomatik olarak kurulum aşamasına geçer.",
    progressLabel: "İlerleme",
    etaLabel: "Kalan",
  },
  installing: {
    eyebrow: "Kuruluyor",
    title: "Yeni sürüm yazılıyor",
    verify: "minisign doğrulaması",
    body: "LumaSync v{{version}} dosyaları yazılıyor.<br/>Kurulum tamamlanınca uygulama otomatik yeniden başlayacak — lütfen pencereyi kapatma.",
  },
  error: {
    eyebrow: "Güncelleme başarısız",
    title: "Kurulum tamamlanamadı",
    body: "Mevcut sürümü kullanmaya devam edebilirsin. Aşağıdaki hataya bak ya da tekrar dene.",
    boxTitle: "Güncelleme hatası",
    checkEyebrow: "Güncelleme kontrolü başarısız",
    checkTitle: "Güncelleme sunucusuna ulaşılamadı",
    checkBody: "Hiçbir şey değişmedi — hâlâ çalıştırdığın sürümdesin. Bu genelde bağlantı olmadığı ya da ağda bir şeyin isteği engellediği anlamına gelir.",
    detailTitle: "Teknik ayrıntı",
  },
  actions: {
    later: "Sonra",
    install: "Kur ve yeniden başlat",
    background: "Arkaplana al",
    close: "Kapat",
    retry: "Tekrar dene",
  },
  noteKind: {
    fix: "Düzeltildi",
    add: "Eklendi",
    change: "Değiştirildi",
  },
  sizeUnknown: "Boyut bilinmiyor",
  checkForUpdates: "Yazılım güncellemesi",
  checkForUpdatesDescription: "LumaSync'in en son sürümünü kontrol et.",
  checkAction: "Güncellemeleri kontrol et",
  betaChannel: "Beta kanalı",
  betaChannelDescription:
    "Kararlı sürümlerin yanı sıra ön sürümleri de al. CI her birini derleyip test eder ve yayınlamadan önce macOS, Linux AppImage ve Windows uygulamasını çalıştırır, ancak .msi ve .deb kurulum dosyalarını hiç çalıştırmaz — pürüz bekle. Ön sürüm kullanırken varsayılan olarak açıktır.",
  checking: "Kontrol ediliyor…",
  upToDate: "En son sürümü kullanıyorsun · {{time}} itibarıyla",
};

export default updater;
