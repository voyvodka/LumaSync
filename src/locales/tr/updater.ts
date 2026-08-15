import type { Catalogue } from "@/features/i18n/catalogue";
import type enUpdater from "@/locales/en/updater";

const updater: Catalogue<typeof enUpdater> = {
  available: {
    eyebrow: "Güncelleme hazır",
    title: "Yeni bir sürüm var",
    body: "LumaSync <b>v{{version}}</b> indirilmeye hazır. Uygulama yeniden başlatıldığında yüklenir.",
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
    body: "Mevcut sürümü kullanmaya devam edebilirsiniz. Aşağıdaki hatayı inceleyin veya tekrar deneyin.",
    boxTitle: "Güncelleme hatası",
    checkEyebrow: "Güncelleme kontrolü başarısız",
    checkTitle: "Güncelleme sunucusuna ulaşılamadı",
    checkBody: "Hiçbir şey değişmedi — çalıştırdığınız sürümdesiniz. Bu genelde bağlantı olmadığı ya da ağda bir şeyin isteği engellediği anlamına gelir.",
    detailTitle: "Teknik ayrıntı",
  },
  actions: {
    later: "Sonra",
    install: "Kur ve yeniden başlat",
    background: "Arkaplana al",
    showLogs: "Log göster",
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
    "Kararlı sürümlerin yanı sıra ön sürümleri de al. Ön sürümler CI tarafından derlenip test edilir, ancak paketlenmiş kurulum dosyasının kendisi hiçbir zaman çalıştırılarak sınanmaz — pürüz bekleyin.",
  checking: "Kontrol ediliyor...",
};

export default updater;
