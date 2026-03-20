# Phase 4: Calibration Workflow - Research

**Researched:** 2026-03-19
**Domain:** Tauri + React calibration wizard, LED geometry mapping, and live test-pattern validation
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
### Wizard Tetikleme ve Yüzeyi
- Wizard ilk cihaz bağlantısında otomatik tetikleniyor (kalibrasyon tamamlanmadan LED modu etkinleştirilemez).
- Wizard tam ekran overlay olarak açılıyor — mevcut SettingsLayout'un üstünde çakışmadan çalışır.
- İlk kurulumda ve sonraki düzenlemelerde aynı interaktif LED map editor ekranı kullanılıyor.
- Settings sidebar'a yeni bir "Calibration" bölümü ekleniyor; bu bölüm özet gösterimi + "Düzenle" butonu içeriyor, butona tıklanınca overlay açılıyor.

### LED Map Editor — Görsel Model
- Editör, tam ekran şeffaf overlay üzerinde monitörü çevreleyen LED band'ının görsel temsilini gösteriyor.
- Monitor dört kenar segmente ayrılmış: Top, Left, Right, Bottom.
- Bottom kenar ise Bottom-Left ve Bottom-Right olarak ikiye ayrılabiliyor (aralarında gap değeri — monitör ayağı boşluğu için).
- Her segmentin pixel sayısı ayrı ayrı tanımlanıyor.
- LED başlangıç noktası herhangi bir segmentin başı veya sonunda olabiliyor; segment kenarlarında tıklanabilir başlangıç noktası işaretçileri var.
- Başlangıç noktası seçilince yön (CW/CCW) belirleniyor; diyagramda ok animasyonuyla sıra gösteriliyor.

### Şablon Sistemi
- 5-8 yaygın monitör boyutu hardcoded şablon olarak sunuluyor (örn: 24" 16:9, 27" 16:9, 32" 16:9, 27" QHD, 34" Ultrawide).
- Şablon seçimi zorunlu değil — kullanıcı şablonsuz da başlayabilir (tüm alanlar boş/sıfır gelir).
- Şablon seçilince öneri değerler LED map editor'e yükleniyor; kullanıcı bunları kendi donanımına göre düzenleyebiliyor.
- Tekrar düzenleme sırasında mevcut kaydedilmiş değerler yükleniyor, şablon seçim adımı atlanıyor.
- Kullanıcı isterse "Sıfırla / Şablon seç" butonu ile şablon seçim ekranına dönebiliyor.
- Şablon sistemi v1'de hardcoded; dış dosya/konfig yükleme sonraki faz.

### Canlı Doğrulama (Test Pattern)
- LED map editor ekranında bir "Test Pattern" toggle/butonu var.
- Test pattern aktifken: overlay üzerinden segment sırasını izleyen gradient animasyon dönüyor; aynı anda fiziksel LED'lere de aynı animasyon gönderiliyor.
- Kullanıcı ekranda gördüğü sıra ile fiziksel şeridi karşılaştırarak doğrulama yapabiliyor.
- Animasyon tarzı ve hızı Claude'a bırakılıyor — görsel doğrulama için en açık senkronizasyonu sağlayacak seçim.
- "Kaydet" butonu her zaman görünür; test pattern zorunlu değil (görsel yardımcı, kilid değil).
- Cihaz bağlı değilken editor açılabiliyor; sadece fiziksel test pattern gönderimi devre dışı kalıyor, harita yine kaydedilebiliyor.

### Kalibrasyon Verisi Kalıcılığı
- Kalibrasyon verisi `ShellState`'e yeni bir `ledCalibration?: LedCalibrationConfig` alanı olarak ekleniyor — mevcut plugin-store altyapısı yeniden kullanılıyor.
- Kayıt explicit "Kaydet" butonu ile gerçekleşiyor (otomatik kayıt yok).
- Kaydedilmemiş değişiklikle editörden çıkılmak istenince onay modal'ı gösteriliyor.
- Settings > Calibration bölümü özet bilgi (kaç LED, hangi şablon) + "Düzenle" butonu gösteriyor.

### Claude's Discretion
- Test pattern animasyonunun tam tarzı ve hızı (görsel doğrulama için uygun olan).
- Segment pixel sayıları için UI input tasarımı (spinner, sayı alanı vb.).
- Overlay z-index yönetimi ve Tauri pencere katmanlama detayları.
- EN/TR kalibrasyon copy wording (mevcut ton kararlarıyla uyumlu).
- Kaydedilmemiş değişiklik tespiti stratejisi.

### Deferred Ideas (OUT OF SCOPE)
- Profil kaydetme/yükleme (birden fazla kalibrasyon profili) — v2 PROF-01 gereksinimi.
- Dış JSON/YAML dosyasından şablon yükleme — v1'de hardcoded, sonraki faz genişletilir.
- Çoklu monitör kalibrasyonu — v2 MMON-01 gereksinimi.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CAL-01 | User can complete setup using predefined monitor LED templates | Template catalog model, wizard entry flow, and template-apply/reset pattern are specified below |
| CAL-02 | User can set LED start index and direction for correct strip orientation | Canonical LED index derivation pattern and CW/CCW traversal mapping are defined below |
| CAL-03 | User can configure edge LED counts and gap areas (for example bottom center gap) | Segment schema (Top/Left/Right/BottomLeft/BottomRight + gap) and validation rules are defined below |
| CAL-04 | User can validate mapping using live preview/test pattern before saving | Frontend preview + Rust command bridge pattern and device-disconnected behavior are defined below |
| UX-02 | User can complete first-time setup via guided wizard and later use advanced settings panel | Auto-open first-time wizard + reusable advanced Calibration section flow is defined below |
</phase_requirements>

## Summary

Phase 4 should be planned as a single calibration domain implemented in two entry points: (1) first-time guided overlay wizard and (2) Settings > Calibration advanced re-entry. The same editor state and rendering logic must power both paths to avoid drift between first setup and later edits.

Current repo patterns strongly favor contracts-first IDs (`shell.ts`), explicit actions (no implicit save), plugin-store persistence, and typed Tauri command bridge via `invoke`. This means planning should center on one typed `LedCalibrationConfig` contract, one canonical LED index builder, and one explicit save/apply lifecycle.

For live validation, use dual-path test pattern behavior: always animate visual overlay locally, and conditionally mirror to hardware when device is connected. Keep this non-blocking (save allowed without test run), but provide clear status messaging to prevent silent mismatch.

**Primary recommendation:** Implement a deterministic calibration engine (segment schema + index ordering + validation) first, then wire wizard/advanced UI as thin shells around that engine.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | `^19.1.0` | Wizard/overlay/editor UI state | Already established app UI stack and component architecture |
| TypeScript | `~5.8.3` | Typed calibration contracts and mapping logic | Prevents index/order bugs across UI + persistence + bridge |
| Tauri command bridge (`@tauri-apps/api/core` + `#[tauri::command]`) | `@tauri-apps/api ^2`, `tauri = "2"` | Send test pattern requests to Rust and return status | Official, typed IPC path already used in device flow |
| Tauri Store plugin (`@tauri-apps/plugin-store`) | `^2.4.2` | Persist `ShellState.ledCalibration` | Existing persistence backbone in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| react-i18next + i18next | `react-i18next ^16.5.8`, `i18next ^25.8.19` | EN/TR copy parity for wizard/editor/status text | Every user-facing calibration string |
| Tailwind v4 utility classes | `tailwindcss ^4.1.11` | Overlay/editor layout and visual affordances | Fast iteration for complex calibration UI states |
| Vitest | `^3.0.0` (project locked) | Unit tests for mapping engine and reducers | Deterministic geometry/index logic and guard rails |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native SVG editor in React | Canvas engine | Canvas gives raw drawing speed but increases hit-testing complexity for clickable start markers |
| In-process store-only preview | Event bus streaming for pattern updates | Event streaming is useful for high-frequency telemetry; command calls are simpler for explicit toggle on/off behavior |
| Single monolithic component state | Reducer-based calibration state machine | Reducer has higher upfront setup but scales better for wizard + advanced reuse + dirty tracking |

**Installation:**
```bash
yarn add @tauri-apps/api @tauri-apps/plugin-store react-i18next i18next
yarn add -D vitest
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── features/calibration/              # Calibration domain
│   ├── model/                         # types, templates, validators, index mapping
│   ├── state/                         # reducer/selectors/dirty-check helpers
│   ├── ui/                            # wizard/editor/panel components
│   └── calibrationApi.ts              # invoke wrappers for test-pattern commands
├── features/settings/sections/        # CalibrationSection entry in settings panel
├── shared/contracts/                  # shell.ts + calibration contract exports
└── locales/{en,tr}/common.json        # calibration copy parity

src-tauri/src/
├── commands/calibration.rs            # test-pattern commands
└── lib.rs                             # command registration
```

### Pattern 1: Contracts-First Calibration Schema
**What:** Define `LedCalibrationConfig` once in shared contracts, persist in `ShellState`, and consume everywhere.
**When to use:** Immediately (first implementation task).
**Example:**
```typescript
// Source: project convention + Tauri store usage
export interface LedCalibrationConfig {
  templateId?: string;
  counts: {
    top: number;
    left: number;
    right: number;
    bottomLeft: number;
    bottomRight: number;
  };
  bottomGapPx: number;
  startAnchor: "top-start" | "top-end" | "left-start" | "left-end" | "right-start" | "right-end" | "bottom-left-start" | "bottom-left-end" | "bottom-right-start" | "bottom-right-end";
  direction: "cw" | "ccw";
  totalLeds: number;
}
```

### Pattern 2: Deterministic Index Builder (Single Source of Truth)
**What:** Build one pure function that outputs visual + physical LED order from counts, gap, start anchor, and direction.
**When to use:** Before building UI interactions.
**Example:**
```typescript
// Source: derived from CAL-02/CAL-03 requirements
export function buildLedSequence(config: LedCalibrationConfig): Array<{ index: number; segment: string; localIndex: number }> {
  const linear = [
    ...segment("top", config.counts.top),
    ...segment("right", config.counts.right),
    ...segment("bottomRight", config.counts.bottomRight),
    ...segment("bottomLeft", config.counts.bottomLeft),
    ...segment("left", config.counts.left),
  ];

  const rotated = rotateToAnchor(linear, config.startAnchor);
  const ordered = config.direction === "cw" ? rotated : [...rotated].reverse();
  return ordered.map((item, index) => ({ ...item, index }));
}
```

### Pattern 3: Explicit Test Pattern Lifecycle
**What:** Start/stop commands are explicit actions; frontend animation runs regardless of device connectivity.
**When to use:** Whenever test toggle changes or editor unmounts.
**Example:**
```typescript
// Source: https://v2.tauri.app/develop/calling-rust
import { invoke } from "@tauri-apps/api/core";

export async function startCalibrationTestPattern(payload: { map: LedCalibrationConfig; speedMs: number }) {
  return invoke("start_calibration_test_pattern", payload);
}

export async function stopCalibrationTestPattern() {
  return invoke("stop_calibration_test_pattern");
}
```

### Anti-Patterns to Avoid
- **Dual mapping logic:** Never compute LED order separately in wizard and advanced panel; use one shared engine.
- **Implicit persistence:** Do not auto-save on every input; keep explicit `Save` action (locked decision).
- **Magic section IDs:** Continue using `SECTION_IDS` contract instead of ad hoc strings.
- **Interval-based animation drift:** Avoid `setInterval` for visual order verification; use `requestAnimationFrame` timestamp progression.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-process frontend/backend bridge | Custom IPC layer | Tauri commands + `invoke` | Officially typed, already integrated, lower maintenance |
| Persistent settings storage | Custom file read/write service | `@tauri-apps/plugin-store` | Handles async persistence lifecycle and shared app/resource table semantics |
| Animation frame scheduler | Manual timer loops with fixed ms ticks | `requestAnimationFrame` | Better sync with display refresh and less drift |
| Locale fallback/pluralization internals | Manual translation maps | Existing i18next/react-i18next setup | Already standardized across app and prevents EN/TR divergence |

**Key insight:** Calibration is correctness-heavy, so reliability comes from reusing proven infrastructure (contracts, plugin-store, invoke bridge), not from introducing bespoke layers.

## Common Pitfalls

### Pitfall 1: Off-by-one and segment boundary mismatch
**What goes wrong:** Visual marker order and saved physical index order diverge by one or more LEDs.
**Why it happens:** Multiple index transformations (anchor rotate + direction reverse + gap split) are applied in different places.
**How to avoid:** Centralize mapping in one pure function and unit test each anchor/direction pair.
**Warning signs:** User picks same start marker but physical strip starts one LED later.

### Pitfall 2: Gap treated as LEDs instead of skipped space
**What goes wrong:** Bottom-center stand gap incorrectly consumes LED indices.
**Why it happens:** Rendering model and LED count model are mixed.
**How to avoid:** Keep `bottomGapPx` visual-only; LED sequence built only from segment counts.
**Warning signs:** `totalLeds` changes when only gap size changes.

### Pitfall 3: Test pattern left running after editor close
**What goes wrong:** Hardware keeps animating after overlay is dismissed.
**Why it happens:** Missing explicit stop on unmount/close/cancel flows.
**How to avoid:** Call stop command in cleanup and before save/cancel route exits.
**Warning signs:** Re-opening editor shows stale running state.

### Pitfall 4: Dirty-state false positives/negatives
**What goes wrong:** Unsaved-change modal appears incorrectly or fails to appear.
**Why it happens:** Mutable object references and ad hoc equality checks.
**How to avoid:** Snapshot baseline on open and compare normalized serialized model.
**Warning signs:** Toggle on/off back to original still marked dirty.

## Code Examples

Verified patterns from official sources:

### Register and Invoke Tauri Commands
```rust
// Source: https://v2.tauri.app/develop/calling-rust
#[tauri::command]
pub fn start_calibration_test_pattern() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![start_calibration_test_pattern])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

```typescript
// Source: https://v2.tauri.app/develop/calling-rust
import { invoke } from "@tauri-apps/api/core";

await invoke("start_calibration_test_pattern", { speedMs: 80 });
```

### Load and Persist Store State
```typescript
// Source: https://v2.tauri.app/plugin/store/
import { load } from "@tauri-apps/plugin-store";

const store = await load("shell-state.json", { autoSave: true });
await store.set("shell-state", { ledCalibration: {/* ... */} });
```

### Frame-accurate Overlay Animation Loop
```typescript
// Source: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
let rafId: number | null = null;

function tick(timestamp: number) {
  updateGradientByTimestamp(timestamp);
  rafId = requestAnimationFrame(tick);
}

rafId = requestAnimationFrame(tick);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Ad hoc command wiring in one file | Module-based command organization + single `generate_handler!` registration list | Tauri v2 docs (current) | Cleaner scaling for new calibration commands |
| Timer-driven animation (`setInterval`) | Refresh-rate-aligned `requestAnimationFrame` with timestamp delta | Web platform best-practice | Better sync on 60/120/144Hz displays |
| Optional local persistence patterns | Plugin-store with async load/set and permission model | Tauri plugin-store v2 | Consistent persistence behavior across restarts |

**Deprecated/outdated:**
- Multiple `.invoke_handler(...)` calls for different command sets: only one effective handler list should be used.

## Open Questions

1. **Exact LED device protocol for test pattern payload**
   - What we know: Current backend handles scan/connect/health only; no LED frame send command exists yet.
   - What's unclear: Binary/text framing, packet size, and required send cadence for target controller firmware.
   - Recommendation: Plan a Wave 0 interface contract between calibration command and device transport before UI implementation.

2. **Disconnected-state UX details for test toggle**
   - What we know: Decision says editor should work offline; hardware send disabled when not connected.
   - What's unclear: Exact copy and whether toggle should remain enabled with warning vs split button.
   - Recommendation: Keep toggle enabled, show inline "preview-only" status badge, and avoid modal interruptions.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^3.0.0` |
| Config file | `vitest.config.ts` |
| Quick run command | `yarn vitest run src/features/calibration/model/*.test.ts` |
| Full suite command | `yarn vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAL-01 | Template apply/reset populates calibration model correctly | unit | `yarn vitest run src/features/calibration/model/templates.test.ts -t "applies predefined template"` | ❌ Wave 0 |
| CAL-02 | Start anchor + CW/CCW produce deterministic index order | unit | `yarn vitest run src/features/calibration/model/indexMapping.test.ts -t "maps start anchor and direction"` | ❌ Wave 0 |
| CAL-03 | Segment counts + bottom gap validation rules hold | unit | `yarn vitest run src/features/calibration/model/validation.test.ts -t "validates counts and gap"` | ❌ Wave 0 |
| CAL-04 | Test toggle triggers start/stop command orchestration | unit | `yarn vitest run src/features/calibration/state/testPatternFlow.test.ts -t "starts and stops pattern"` | ❌ Wave 0 |
| UX-02 | First-time wizard auto-open + advanced reopen path use same state | unit | `yarn vitest run src/features/calibration/state/entryFlow.test.ts -t "reuses editor state"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `yarn vitest run src/features/calibration/model/*.test.ts`
- **Per wave merge:** `yarn vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/features/calibration/model/indexMapping.test.ts` — covers REQ-CAL-02
- [ ] `src/features/calibration/model/templates.test.ts` — covers REQ-CAL-01
- [ ] `src/features/calibration/model/validation.test.ts` — covers REQ-CAL-03
- [ ] `src/features/calibration/state/testPatternFlow.test.ts` — covers REQ-CAL-04
- [ ] `src/features/calibration/state/entryFlow.test.ts` — covers REQ-UX-02
- [ ] Optional component test environment (`jsdom`) if UI interaction tests are added later

## Sources

### Primary (HIGH confidence)
- `/websites/v2_tauri_app` (Context7) - commands/invoke handler behavior, managed state access
- https://v2.tauri.app/develop/calling-rust/ - Tauri v2 command registration/invocation rules, async behavior, handler constraints
- https://v2.tauri.app/plugin/store/ - plugin-store load/set/save behavior, permissions, setup
- Local codebase: `src/shared/contracts/shell.ts`, `src/features/shell/windowLifecycle.ts`, `src/features/device/deviceConnectionApi.ts`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/device_connection.rs`

### Secondary (MEDIUM confidence)
- https://vitest.dev/guide/ - current Vitest usage and command patterns (cross-checked with local `vitest.config.ts`)
- https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame - animation timing guidance for frame-synced previews

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - verified from project manifests and official Tauri docs
- Architecture: MEDIUM - mostly project-grounded, but calibration-specific editor structure is new work
- Pitfalls: MEDIUM - grounded in known LED mapping failure modes and current architecture constraints

**Research date:** 2026-03-19
**Valid until:** 2026-04-18
