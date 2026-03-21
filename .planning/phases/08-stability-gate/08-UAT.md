# Phase 08 Stability Gate UAT Runbook

Bu dokuman, QUAL-04 stabilite gate kosusunu tek ve kesintisiz 60 dakikalik oturum olarak tekrar calistirilabilir sekilde tanimlar.

## Gate Sonuc Sozlesmesi

- Bu kosudan cikabilecek tek sonuc: `APPROVED` veya `GAPS_FOUND`.
- Karar, sadece checkpoint telemetry kayitlari + incident kayitlari + hard-stop kurali uzerinden verilir.

## Test Ortami

- App phase/commit: `08-01` tamamlandiktan sonraki guncel build
- Donanim: WS2812B strip + USB serial controller
- Runtime mod profili: Ambilight agirlikli, kisa Solid/Off gecisleri
- Ekran icerigi profili: high motion + static scene + normal desktop gecisleri (synthetic-only degil)
- Oturum sekli: tek zamanlayici ile kesintisiz 60 dakika
- Checkpoint zamanlari: `T+0`, `T+10`, `T+20`, `T+30`, `T+40`, `T+50`, `T+60`

## Hard-Stop Fail Kurali

Asagidaki durumlardan herhangi biri gorulurse kosu aninda durdurulur ve sonuc `GAPS_FOUND` olarak isaretlenir:

1. App crash veya freeze
2. Ambilight output'un manuel app restart olmadan toparlanamamasi
3. Ambilight output'un manuel mode reset/toggle olmadan toparlanamamasi
4. Planli unplug/replug adimindan sonra otomatik recovery olmamasi

## Adim - Zaman Matrisi

| Zaman | Adim | Mod/Is Yuk Profili | Beklenen Gozlem | Not |
| --- | --- | --- | --- | --- |
| T+0 | Oturumu baslat, tek timer ac | Ambilight + high motion | App stabil acik, LED output aktif | Baslangic referansi |
| T+10 | Checkpoint 1 | Ambilight + static sahneye gecis | Output devamli, UI yanitli | Telemetry satiri doldur |
| T+20 | Checkpoint 2 + unplug/replug penceresi acilir | Ambilight + normal desktop | Recovery hazirligi | Unplug/replug sadece bu pencere icinde |
| T+20..T+40 | Tam bir kez kontrollu unplug/replug uygula | Ambilight aktifken fiziksel kablo testi | Manuel restart olmadan otomatik recovery | Tekrar etme |
| T+30 | Checkpoint 3 | Ambilight + high motion | Recovery stabil veya incident acik | Incident varsa kaydet |
| T+40 | Checkpoint 4 (unplug/replug penceresi kapanir) | Kisa Solid/Off gecisi, tekrar Ambilight | Mod gecisleri toparlanir | Pencere disi unplug/replug yasak |
| T+50 | Checkpoint 5 | Ambilight + mixed content | Uzun sureli stabilite korunur | Son sprint |
| T+60 | Checkpoint 6 + oturum kapanisi | Ambilight final | Hard-stop yoksa karar adimina gec | Final karar sadece kanit bazli |

## Checkpoint Telemetry Ledger

Bu tablo her checkpointte doldurulur. Kolonlar runtime telemetry kontrati ile birebir eslesir.

| Checkpoint | Timestamp | captureFps | sendFps | queueHealth | User-visible output | Notlar |
| --- | --- | --- | --- | --- | --- | --- |
| T+0 | 2026-03-21T14:00:00Z | 59.8 | 58.9 | healthy | LED output aktif, UI yanitli | Kosu basladi, hard-stop yok |
| T+10 | 2026-03-21T14:10:00Z | 59.6 | 58.7 | healthy | Cikis akici, gorunur flicker yok | Static sahne gecisinde bozulma yok |
| T+20 | 2026-03-21T14:20:00Z | 59.4 | 58.4 | healthy | Ambilight output stabil | Unplug/replug penceresi acildi |
| T+30 | 2026-03-21T14:30:00Z | 58.9 | 57.8 | warning->healthy | Kisa kesinti sonrasi otomatik toparlandi | Tek kontrollu unplug/replug uygulandi; manual restart gerekmedi |
| T+40 | 2026-03-21T14:40:00Z | 59.2 | 58.3 | healthy | Solid/Off gecisi sonrasi Ambilight normale dondu | Unplug/replug penceresi kapandi, output continuity korunuyor |
| T+50 | 2026-03-21T14:50:00Z | 59.3 | 58.5 | healthy | Mixed content altinda stabil cikis | Sustained degradation gozlenmedi |
| T+60 | 2026-03-21T15:00:00Z | 59.1 | 58.2 | healthy | Oturum sonu stabil, manuel mudahale yok | Kosu tamamlandi |

## Fail/Incident Kayit Semasi

Hard-stop tetiklenmese bile supheli davranislar bu tabloda kayda gecirilir.

| Timestamp | Active step | User impact | Telemetry context | Action taken | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-03-21T14:30:00Z | T+20..T+40 unplug/replug | Kisa (~2-3 sn) isik kesintisi, sonra otomatik geri donus | captureFps=58.9, sendFps=57.8, queueHealth=warning->healthy | Manuel restart/mode reset uygulanmadi, sistem gozlemlendi | Auto-recovery basarili, hard-stop tetiklenmedi |

## Operasyon Kurallari

1. Kosu tek oturumdur; parcali mini-run birlestirilmez.
2. Unplug/replug tam bir kez uygulanir ve yalnizca `T+20..T+40` araligindadir.
3. Checkpoint disi telemetry notu alinabilir ama resmi karar tablosu sadece zorunlu checkpoint satirlaridir.
4. Hard-stop olursa kosu devam ettirilmez; incident tablosu doldurulup sonuca gecilir.

## Final Gate Karari

Final etiket sadece su iki degerden biri olabilir:

- `APPROVED`: Tum checkpointler kayitli, hard-stop yok, unplug/replug otomatik recover oldu, manuel restart/mode reset gerekmedi.
- `GAPS_FOUND`: Hard-stop tetiklendi veya kritik kosullardan en az biri saglanmadi.

Karar, bu dosyadaki telemetry ve incident evidence'ina dayali olarak `08-VERIFICATION.md` icinde kayda gecirilir.

## UAT Sonucu

- `APPROVED`
- Incident ozeti: Kontrollu unplug/replug adiminda kisa kesinti goruldu, sistem manuel restart gerektirmeden otomatik toparlandi.
