# Phase 05 Hardware UAT Checklist

Bu dokuman, Phase 05 core lighting modes icin 05-04 gap-closure sonrasi fiziksel donanim dogrulama sonucunu kaydeder.

## Test Ortami

- App version/commit: `059dc11` (Task 2 GREEN)
- Donanim: WS2812B strip + USB serial controller
- Tester: Human verification (checkpoint approved)
- Tarih/Saat: 2026-03-21

## Sonuc Ozeti

- Toplam test: 3
- Passed: 3
- Failed: 0
- Blocked: 0
- Genel karar: APPROVED

## Requirement Esleme Matrisi

| Requirement | Test ID'leri |
| --- | --- |
| MODE-01 | MODE-01-01 |
| MODE-02 | MODE-02-01, MODE-02-02 |

## Test Cases

### MODE-01-01 - Ambilight gercek zamanli takip

- Requirement: MODE-01
- Adimlar:
  1. General > Lighting ekraninda Ambilight sec.
  2. Ekranda hizli kontrastli renk hareketleri olustur.
- Beklenen sonuc:
  - LED cikisi ekran renk degisimlerini anlik takip eder.

### MODE-02-01 - Solid uniformluk

- Requirement: MODE-02
- Adimlar:
  1. Solid sec.
  2. Kirmizi/yesil/mavi ve farkli brightness degerlerini dene.
- Beklenen sonuc:
  - Tum seritte uniform renk/parlaklik cikisi olur.

### MODE-02-02 - Mod gecisi + Off davranisi + kalibrasyon korunumu

- Requirement: MODE-02
- Adimlar:
  1. Ambilight <-> Solid gecisini en az 5 kez tekrar et.
  2. Off moduna gecip fiziksel cikisin durdugunu dogrula.
  3. Gecislerden sonra kalibrasyon kaydinin korunup korunmadigini kontrol et.
- Beklenen sonuc:
  - Tek aktif runtime kurali bozulmadan gecisler calisir.
  - Off modunda fiziksel cikis durur.
  - Kalibrasyon kaydi korunur.

## Sonuc Kaydi

| Test ID | Sonuc (PASS/FAIL/BLOCKED) | Kanit Notu | Fail Detayi (varsa) |
| --- | --- | --- | --- |
| MODE-01-01 | PASS | Ambilight seciminde LED'ler ekran hareketlerini gercek zamanli takip etti. | - |
| MODE-02-01 | PASS | Solid modda renk/parlaklik degisimleri tum seritte uniform uygulandi. | - |
| MODE-02-02 | PASS | Ambilight<->Solid gecisleri stabil calisti, Off fiziksel cikisi durdurdu, kalibrasyon kaybi gozlenmedi. | - |

## Gap/Kapanis Karari

- Gap var mi?: Hayir
- Onerilen sonraki aksiyon: `05-VERIFICATION.md` blocker satirlarini kapatip phase 05 completion kaydini guncelle.
