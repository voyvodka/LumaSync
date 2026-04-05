# Phase 16: Hue Channel Position Editor - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-05
**Phase:** 16-hue-channel-position-editor
**Areas discussed:** Surukleme etkilesimi, Z-ekseni slider tasarimi, Coklu secim ve grup tasima, Editor yerlesimi ve navigasyonu

---

## Surukleme Etkilesimi

### Drag modu

| Option | Description | Selected |
|--------|-------------|----------|
| Mod ayrimi (Tavsiye edilen) | Editorde iki mod: "Konumlandir" (drag aktif) ve "Bolge Ata" (zone overlay). Toggle butonla gecis. | ✓ |
| Uzun basili tutma | Kisa tik = zone, 200ms+ = drag. Hassas zamanlama gerektirir. | |
| Her zaman drag | Zone assignment chip listesine tasinir, haritada sadece drag. | |

**User's choice:** Mod ayrimi
**Notes:** Net ayrim, kaza ile tasima onlenir.

### Drag UX

| Option | Description | Selected |
|--------|-------------|----------|
| Canli koordinat tooltip (Tavsiye edilen) | Suruklenen noktanin yaninda x/y degerleri tooltip ile gosterilir. | ✓ |
| Sadece gorsel geri bildirim | Tooltip yok, sadece nokta hareketi ve glow efekti. | |
| Kilavuz cizgileri + koordinat | Crosshair cizgileri + tooltip. | |

**User's choice:** Canli koordinat tooltip
**Notes:** Hassas konumlandirma icin faydali.

### Snap davranisi

| Option | Description | Selected |
|--------|-------------|----------|
| Snap yok (Tavsiye edilen) | Serbest surukleme, [-1.0, 1.0] clamp. | ✓ |
| Opsiyonel grid snap | Shift ile 0.1 adimli grid snap. | |

**User's choice:** Snap yok
**Notes:** Hue koordinat sistemi surekli, snap gereksiz karmasiklik.

---

## Z-ekseni Slider Tasarimi

### Slider yerlesimi

| Option | Description | Selected |
|--------|-------------|----------|
| Secili kanal detay paneli (Tavsiye edilen) | Harita altinda kucuk detay seridi: kanal adi, x/y (read-only), z slider. | ✓ |
| Chip listesi icinde inline | Her chip'e kucuk slider eklenir. | |
| Harita uzerinde dikey gosterge | Secili noktanin yaninda dikey slider. | |

**User's choice:** Secili kanal detay paneli
**Notes:** Tek kanal odakli, temiz.

### Slider hassasiyeti

| Option | Description | Selected |
|--------|-------------|----------|
| Surekli slider + sayisal deger (Tavsiye edilen) | 0.01 adimli slider, yaninda sayisal deger. Dot boyutu degismez. | ✓ |
| Surekli slider + dot boyut degisimi | Slider + deger + haritada nokta boyutu z'ye gore degisir. | |

**User's choice:** Surekli slider + sayisal deger
**Notes:** Basit ve yeterli.

---

## Coklu Secim ve Grup Tasima

### Secim yontemi

| Option | Description | Selected |
|--------|-------------|----------|
| Shift+click (Tavsiye edilen) | Normal tik = tek, Shift+tik = ekle/cikar. Standart masaustu pattern. | ✓ |
| Lasso secim | Dikdortgen cizerek secim. DOM drag ile cakisma riski. | |
| Chip listesinde checkbox | Haritadan bagimsiz secim. | |

**User's choice:** Shift+click
**Notes:** Basit, ogrenilebilir.

### Sinir davranisi

| Option | Description | Selected |
|--------|-------------|----------|
| Clamp ve dur (Tavsiye edilen) | Bir kanal sinira ulasirsa tum grup durur. Goreceli pozisyonlar korunur. | ✓ |
| Bireysel clamp | Her kanal bagimsiz clamp. Goreceli pozisyonlar bozulabilir. | |

**User's choice:** Clamp ve dur
**Notes:** Goreceli pozisyonlarin korunmasi onemli.

---

## Editor Yerlesimi ve Navigasyonu

### Yerlesim

| Option | Description | Selected |
|--------|-------------|----------|
| Mevcut paneli genislet (Tavsiye edilen) | HueChannelMapPanel'e drag + z-slider + multi-select eklenir. Settings > Device'da kalir. | ✓ |
| Ayri tam sayfa | Yeni CalibrationPage benzeri sayfa. | |
| Genisletilebilir panel | Mevcut panelde "Genislet" butonu. | |

**User's choice:** Mevcut paneli genislet
**Notes:** Minimum navigasyon degisikligi.

### Kaydetme

| Option | Description | Selected |
|--------|-------------|----------|
| Lokal ShellState (Tavsiye edilen) | Anlik persist, bridge'e gonderilmez. Phase 20'de bridge yazma. | ✓ |
| Explicit kaydet butonu | Gecici state, "Kaydet" butonu ile persist. | |

**User's choice:** Lokal ShellState
**Notes:** Bridge yazma Phase 20 kapsaminda.

---

## Claude's Discretion

- Pointer event handler implementasyonu
- Tooltip pozisyonu ve stili
- Detay seridi animasyonu
- Mod toggle buton tasarimi
- Multi-select gorsel gostergesi

## Deferred Ideas

None — discussion stayed within phase scope.
