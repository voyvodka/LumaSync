# Phase 15: Fault Recovery and Diagnostics - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-30
**Phase:** 15-fault-recovery-and-diagnostics
**Areas discussed:** Otomatik kurtarma davranisi, Hata mesaji tasarimi, Telemetry Hue saglik sinyalleri, Simule edilmis hata tetikleme

---

## Otomatik kurtarma davranisi

| Option | Description | Selected |
|--------|-------------|----------|
| Sessiz kurtarma | Status card degisir, kullanici mudahale etmez | ✓ |
| Bildirimli kurtarma | Status card + toast/banner gosterimi | |
| Modal uyari | Tam ekran modal ile kullaniciya sorulur | |

**User's choice:** Sessiz kurtarma
**Notes:** Kullanici deneyimini bozmadan arka planda cozulmeli

| Option | Description | Selected |
|--------|-------------|----------|
| Failed state + yeniden dene butonu | Error variant, kullanici karar verir | ✓ |
| Otomatik durdur + bildirim | Stream otomatik durdurulur | |
| Sinirsiz genisletilmis retry | 30s araliklarla suresiz deneme | |

**User's choice:** Failed state + yeniden dene butonu
**Notes:** Kullaniciya kontrol birakılır

---

## Hata mesaji tasarimi

| Option | Description | Selected |
|--------|-------------|----------|
| Kod + aciklama + aksiyon | [HUE-NET-01] formatinda, status card icinde | ✓ |
| Sadece aciklama + aksiyon | Teknik kod gosterilmez | |
| Genisletilebilir detay paneli | Kisa mesaj + detaylar butonu | |

**User's choice:** Kod + aciklama + aksiyon

| Option | Description | Selected |
|--------|-------------|----------|
| Ag/baglanti hatalari | Bridge ulasilamiyor, DTLS, timeout | ✓ |
| Auth/credential hatalari | API key gecersiz, re-pair | ✓ |
| Stream runtime hatalari | Area bulunamiyor, throttle | ✓ |
| Konfigurasyon hatalari | Area secilmemis, IP degismis | ✓ |

**User's choice:** Dort aile de secildi
**Notes:** Kapsamli hata kodlamasi istenildi

---

## Telemetry Hue saglik sinyalleri

| Option | Description | Selected |
|--------|-------------|----------|
| Stream durumu + uptime | Running/Reconnecting/Failed + sure | ✓ |
| Paket hizi + son hata | Paket/s, son hata kodu | ✓ |
| Retry sayaci | Toplam deneme, basarili/basarisiz | ✓ |
| DTLS baglanti detayi | Cipher suite, handshake suresi | ✓ |

**User's choice:** Dort metrik grubu da secildi

| Option | Description | Selected |
|--------|-------------|----------|
| Mevcut paneli genislet | TelemetrySection icine Hue alt bolumu | ✓ |
| Ayri Hue paneli | Device section icinde ayri panel | |

**User's choice:** Mevcut paneli genislet

---

## Simule edilmis hata tetikleme

| Option | Description | Selected |
|--------|-------------|----------|
| Dev-only Tauri komutu | #[cfg(debug_assertions)] korumasinda | ✓ |
| Ortam degiskeni ile tetikleme | HUE_SIMULATE_FAULT=1 | |
| UI dev butonu | Settings icinde dev-only buton | |

**User's choice:** Dev-only Tauri komutu

| Option | Description | Selected |
|--------|-------------|----------|
| DTLS baglanti kopmasi | Soket kapatma ile reconnect tetikle | ✓ |
| Bridge ulasilamazlik | HTTP timeout simulasyonu | |
| Auth gecersizlestirme | API key bozma | |

**User's choice:** Yalnizca DTLS baglanti kopmasi

---

## Claude's Discretion

- Hata kodu numaralandirma semasi
- RuntimeTelemetrySnapshot genisletme vs ayri struct
- DTLS detay metriklerinin Rust'ta nasil toplandigi
- Hue telemetry alt bolumunun gorsel layout'u

## Deferred Ideas

- Bridge ulasilamazlik ve auth gecersizlestirme simulasyonlari
- Frontend log viewer
- Multi-bridge fault isolation
