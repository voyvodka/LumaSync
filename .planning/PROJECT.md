# LumaSync

## What This Is

LumaSync, USB uzerinden baglanan WS2812B tabanli monitor arkasi LED sistemini canli ekran renkleriyle suren, tray-first masaustu uygulamasidir. v1.0 ile birlikte kurulum, kalibrasyon, temel modlar, runtime kalite kontrolu, telemetry gorunurlugu ve EN/TR dil destegi shipping seviyesine ulasmistir.

## Core Value

Users can get smooth, stable, low-overhead Ambilight behavior on a USB-connected WS2812B setup with minimal setup friction.

## Current State

- **Shipped version:** `v1.0` (2026-03-21)
- **Milestone scope:** Phase 1-8 tamamlandi
- **Release gate:** QUAL-04 (60 dakika stabilite) APPROVED
- **Archive refs:** `.planning/milestones/v1.0-ROADMAP.md`, `.planning/milestones/v1.0-REQUIREMENTS.md`
- **v1.1 progress:** Phase 01 complete (2026-03-29) — tray-first shell, startup toggle Rust-authoritative, all UAT gaps closed

## Requirements

### Validated

- ✓ User can connect to a USB serial LED controller through auto-detection with manual port fallback — v1.0
- ✓ User can calibrate LED layout (start pixel, direction, edge counts, and gaps) with visual feedback — v1.0
- ✓ User can run real-time Ambilight mode with soft color averaging that avoids harsh output — v1.0
- ✓ User can use basic non-Ambilight lighting modes (for example solid color and basic presets) — v1.0
- ✓ User can complete guided setup via wizard and then manage detailed options in an advanced panel — v1.0
- ✓ User can observe runtime quality via telemetry and use setup/mode flows in both English and Turkish — v1.0
- ✓ User can complete a 60-minute continuous run without crash or manual recovery — v1.0
- ✓ User can discover, pair, and select a Philips Hue Entertainment Area for streaming — v1.1
- ✓ User can start, sustain, and cleanly stop Hue Entertainment streaming from app mode controls — v1.1

### Active

- [ ] User can position all light sources (Hue, USB LED, future protocols) on a 2D room map
- [ ] User can edit Hue Entertainment Area channel positions and optionally save them back to the bridge
- [ ] User can have Ambilight LED zone assignments auto-derived from the room map
- [ ] User can use Hue standalone (without a USB LED strip) for room-only Hue control
- [ ] User can continue a Hue session after transient stream faults without restarting the app (HUE-08)
- [ ] User can manage Hue connection and stream status from Device settings surfaces (HUX-01)
- [ ] User can switch output target between USB and Hue without losing calibration or mode config (HUX-02)
- [ ] User can see coded Hue error states with actionable recovery hints in UI (HDR-01)
- [ ] User can inspect basic Hue stream health signals for troubleshooting during runtime (HDR-02)
- [ ] User can save and reuse lighting/calibration profiles
- [ ] User can use richer preset effects beyond solid color
- [ ] User can control multiple monitors/controllers with predictable orchestration

### Out of Scope

- Wi-Fi or network-based device control (ESP/network transport) - defer until USB-first path is proven stable
- Cloud sync for profiles/settings - unnecessary for local-first workflow
- Mobile app clients - desktop-first focus
- Advanced visual effect editor (timeline/node-based) - high complexity, defer to later milestone
- Preset marketplace/plugin ecosystem - defer until reliability and UX stay stable across next milestone

## Current Milestone: v1.2 Oda Görselleştirme ve Evrensel Işık Yönetimi

**Goal:** Kullanıcının odadaki tüm ışık kaynaklarını tek bir oda haritasında konumlandırabildiği, Ambilight bölgelerinin bu haritadan otomatik türetildiği ve Hue'nun USB şeritten bağımsız da çalışabildiği evrensel bir ışık yönetim sistemi.

**Target features:**
- 3D/2D oda haritası editörü — Hue, USB LED şerit ve gelecekteki protokollerin konumlandırılması
- Hue Entertainment Area kanal pozisyon editörü — koordinat düzenleme ve opsiyonel olarak bridge'e kaydetme
- Oda haritasından otomatik Ambilight LED bölge ataması
- Hue standalone modu — USB şeritsiz odalar için de çalışır
- v1.1'den taşınan: HUE-08 fault recovery, HUX-01/02 device UX, HDR-01/02 diagnostics

## Constraints

- **Platform**: Windows first
- **Transport**: USB serial first
- **Hardware**: WS2812B addressable LEDs
- **Performance**: Balanced profile (smoothness + low system impact)
- **Stability**: No crash tolerance in release gates
- **Product Shape**: Tray app + full settings window
- **Open Source**: MIT license target

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prioritize smooth Ambilight in v1 | Core product promise and highest user value | Implemented in v1.0 |
| Launch on Windows first | Lower platform risk for capture + USB path | Implemented in v1.0 |
| Use USB serial transport for device communication | Simplest reliable path for Arduino-like hardware | Implemented in v1.0 |
| Include setup wizard plus advanced control panel | Supports both quick start and power users | Implemented in v1.0 |
| Include basic non-Ambilight modes and profile save in v1 | Expands day-to-day utility beyond screen mirroring | Partially implemented (modes yes, profiles deferred) |
| Hue Entertainment integration should follow production-grade references (Hyperion/HyperHDR) while keeping original implementation | Reduce protocol/streaming risk with proven patterns, preserve license-safe code ownership | Active for v1.1 |
| Runtime telemetry is pull-based and exposed as Rust-owned snapshots | Deterministic read path for UI observability with low coupling to worker lifecycle | Implemented in v1.0 |
| EN/TR parity is enforced with deterministic key-set tests and base-language normalization | Prevent i18n drift and avoid redundant writes on regional locale tags | Implemented in v1.0 |
| Use open-source projects as reference, implement original code | Preserve learning benefits while staying license-safe | Implemented in v1.0 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-30 after v1.2 milestone start*
