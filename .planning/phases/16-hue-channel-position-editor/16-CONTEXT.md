# Phase 16: Hue Channel Position Editor - Context

**Gathered:** 2026-04-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Kullanicinin Hue Entertainment Area kanallarini harita uzerinde gormesi, surukleyerek x/y konumlarini guncellemesi, z-ekseni (yukseklik) ayarlamasi ve coklu secim ile grup tasimasi. Kapsam yalnizca CHAN-01, CHAN-02, CHAN-03, CHAN-04 requirement'laridir. Bridge'e yazma (CHAN-05) Phase 20'dedir. Room map (ROOM-*) Phase 17'dedir.

</domain>

<decisions>
## Implementation Decisions

### Drag Etkilesimi (D-01)
- **D-01a:** Mod ayrimi modeli — Editorde iki mod: "Konumlandir" (drag aktif, tik secer) ve "Bolge Ata" (mevcut zone overlay davranisi). Toggle butonla gecis. Kaza ile tasima onlenir.
- **D-01b:** Surukleme sirasinda canli koordinat tooltip gosterilir (orn: "x: 0.42, y: -0.15"). Birakildiginda kaybolur.
- **D-01c:** Snap davranisi yok — serbest surukleme, [-1.0, 1.0] sinirlarinda clamp edilir.

### Z-Ekseni Slider (D-02)
- **D-02a:** Secili kanal detay paneli — bir kanal secildiginde harita altinda kucuk bir detay seridi acilir: kanal adi, x/y koordinatlari (read-only), z slider'i.
- **D-02b:** 0.01 adimli surekli slider + yaninda sayisal deger gosterimi. Dot boyutu z degerine gore degismez.

### Coklu Secim ve Grup Tasima (D-03)
- **D-03a:** Shift+click ile coklu secim. Normal tik = tek secim, Shift+tik = secime ekle/cikar.
- **D-03b:** Grup suruklemede herhangi bir kanal [-1.0, 1.0] sinirina ulasirsa tum grubun o yondeki hareketi durur (clamp ve dur). Goreceli pozisyonlar korunur.

### Editor Yerlesimi (D-04)
- **D-04a:** Mevcut HueChannelMapPanel genisletilir — drag, z-slider, multi-select eklenir. Ayri sayfa olusturulmaz. Settings > Device section'da kalir.
- **D-04b:** Mod toggle (Konumlandir/Bolge Ata) panel header'ina eklenir.

### Kaydetme Davranisi (D-05)
- **D-05a:** Drag ile degisen x/y/z degerleri anlik olarak RoomMapConfig.hueChannels'a yazilir ve plugin-store'a persist edilir. Bridge'e gonderilmez (Phase 20 kapsaminda).

### Claude's Discretion
- Pointer event handler implementasyon detaylari (onPointerDown/Move/Up vs useDrag hook)
- Tooltip pozisyonu ve stili
- Detay seridi animasyonu (slide-in vs fade)
- Mod toggle buton gorsel tasarimi
- Multi-select gorsel gostergesi (secili kanallarin outline/glow stili)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Mevcut panel (genisletilecek)
- `src/features/settings/sections/HueChannelMapPanel.tsx` — Mevcut spatial room view, channel dots, zone overlay, chip listesi. Phase 16 bu dosyayi genisletir.
- `src/features/settings/sections/DeviceSection.tsx` — HueChannelMapPanel'i iceren ust component

### Contract tipleri
- `src/shared/contracts/roomMap.ts` — `HueChannelPlacement` (x/y/z alanlari), `RoomMapConfig` (hueChannels array)
- `src/shared/contracts/hue.ts` — `HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS`, `HUE_STATUS` kodlari
- `src/shared/contracts/shell.ts` — `ShellState` genisletmesi (roomMap, roomMapVersion)

### Persistence
- `src/features/persistence/shellStore.ts` — plugin-store facade, RoomMapConfig persist

### Phase 14 context (prior decisions)
- `.planning/phases/14-contract-foundation/14-CONTEXT.md` — D-01a: Hue native [-1.0, 1.0] range, D-02a: ayri typed arrays, D-03: channel = light source

### Requirements
- `.planning/REQUIREMENTS.md` — CHAN-01 through CHAN-04

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `HueChannelMapPanel.tsx` — Spatial room view, `posToPercent()` ve `distFromCenter()` helper'lari, REGION_COLOR sistemi, chip listesi. Dogrudan genisletilecek.
- `MiniSpatialPreview` — Kucuk dot-map preview, area kartlarinda kullaniliyor
- `HueAreaChannelInfo` (hueOnboardingApi) — Bridge'den gelen kanal verileri (index, positionX, positionY)

### Established Patterns
- Channel dots `absolute` pozisyonlu `button` elementleri olarak render ediliyor
- Hue [-1,1] -> CSS % donusumu `posToPercent()` ile yapiliyor
- `selectedDot` state ile tek secim yonetiliyor (multi-select icin Set<number> yapisina gecirilecek)
- Zone assignment `overrides` Record ile yonetiliyor

### Integration Points
- `HueChannelMapPanel` props'una `onPositionChange` callback eklenmeli
- `shellStore` uzerinden `RoomMapConfig.hueChannels` guncellenmeli
- Mod toggle state'i panel icinde yerel olarak yonetilebilir

</code_context>

<specifics>
## Specific Ideas

- Mod ayrimi masaustu uygulamalarindaki "select vs move" tool pattern'ini takip etmeli
- Koordinat tooltip surukleme sirasinda cursor'un yakininda ama ustunu kapatmayacak sekilde konumlanmali
- Detay seridi (z-slider) secim olmayinca gizlenmeli, alan tasarrufu icin

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 16-hue-channel-position-editor*
*Context gathered: 2026-04-05*
