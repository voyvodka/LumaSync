# Phase 3: Connection Resilience and Health - Research

**Researched:** 2026-03-19
**Domain:** Tauri v2 + Rust serialport connection recovery and setup health validation
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Recovery Automation Policy
- If the last successful port disappears and then reappears, the app should automatically attempt reconnection.
- Auto-recovery should use a staged approach (fast initial attempt, then short bounded retries), then drop to manual-required state after a short timeout window.
- During auto-recovery, UI should expose a dedicated reconnecting state rather than hiding activity.
- If auto-recovery cannot restore connection within the bounded window, status should clearly direct the user to manual next steps.

### Health Check Scope and Results
- Health check is user-triggered from Device panel via an explicit action (for example, Run Health Check).
- Health check uses a three-step baseline: port visibility, support eligibility, and connection + immediate status verification.
- Results should show a top-level PASS/FAIL summary plus per-step outcomes.
- On FAIL, guidance must be actionable and contextual (refresh, choose another port, check cable, retry).

### Connection Condition Feedback
- Inline status card remains the primary status surface (continue Phase 2 pattern).
- Messaging style is calm and action-oriented (quiet-by-default tone, with clear next step).
- Reconnecting and health-fail states remain visible until state changes (no auto-dismiss).
- User-facing text appears first; technical code/details remain secondary.

### User Control During Recovery
- Manual user actions take priority over automation.
- If user selects a different port or starts a manual connect, auto-recovery for the prior port is cancelled.
- Port list remains interactive during recovery so user can pivot quickly.
- Recovery and health check must be mutually exclusive (single active operation at a time).

### Claude's Discretion
- Exact retry/backoff timing constants and timeout values, while preserving "short bounded retries" behavior.
- Final microcopy wording for reconnecting and health-check states in EN/TR, while preserving agreed tone.
- Exact UI affordance for the health-check trigger within Device panel layout.

### Deferred Ideas (OUT OF SCOPE)

None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CONN-03 | User session auto-recovers after cable unplug/replug without app restart | Recovery orchestration pattern, bounded retry policy, operation-cancellation rules, and state/status contract extensions in controller + backend |
| CONN-04 | User can run a connection health check during setup and see pass/fail status | Three-step health-check contract (visibility, eligibility, connect+verify), PASS/FAIL summary model, and Device panel presentation pattern |
</phase_requirements>

## Summary

Bu faz icin en guvenli plan, mevcut Phase 2 controller/hook mimarisini koruyup `useDeviceConnection` tarafina iki yeni orkestrasyon akisi eklemektir: (1) auto-recovery state machine ve (2) user-triggered health-check run. Backendde `serialport` ile port gorunurlugu ve baglanti denemesi zaten var; fakat docs.rs, `available_ports()` sonucunun portun gercekten kullanilabilir oldugunu garanti etmedigini acikca belirtiyor. Bu nedenle plan, tek bir sinyale guvenmeyip adim bazli dogrulama ve acik fail guidance uretmelidir.

Tauri v2 dokumantasyonuna gore mevcut `manage(...)` + `State<Mutex<...>>` yaklasimi dogru ve faz genisletmesi icin yeterli. Gerekiyorsa Rust tarafindan frontend'e event emit etmek mumkun; ancak bu fazin kapsaminda mevcut invoke tabanli akisla (list/connect/status) ilerleyip operation state'ini frontend controller'da yonetmek daha dusuk risklidir. Bu secim mevcut kod yapisiyla uyumlu, degisiklik kapsamini kontrollu tutar.

Test altyapisi Vitest 3 ile mevcut ve device controller unit test paterni oturmus durumda. Plan, CONN-03 ve CONN-04 icin yeni controller test dosyalariyla (retry zamanlama, operation mutual exclusion, health-check adim sonucu) davranis odakli kapsama eklemeli; backend tarafinda ise command-level mantik unit testlenemiyorsa en azindan frontend orchestration seviyesinde deterministic testler zorunlu olmalidir.

**Primary recommendation:** Phase 3'u, mevcut `createDeviceConnectionController` icine eklenen tek-operation recovery/health state machine + backendde kucuk contract genisletmeleri ile uygula; reconnect ve health check davranisini once unit testlerle kilitle.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Tauri | v2 (`tauri = "2"`, `@tauri-apps/api = "^2"`) | Frontend-Rust command bridge, app state, events | Mevcut projede zaten standard; `manage` + `State` ile guvenli paylasimli durum ve command modeli resmi dokumanla uyumlu |
| serialport (Rust) | `4.x` (`serialport = "4"`, docs.rs latest 4.9.0) | Port listeleme ve baglanti denemesi | Cross-platform serial temel katman; proje backendinde aktif kullaniliyor |
| React + hook controller pattern | `react 19.x` | Device panel state orchestration | Phase 2'de testlenmis controller+hook yapisi Phase 3 akislari icin dogrudan genisletilebilir |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| i18next + react-i18next | `i18next 25.x`, `react-i18next 16.x` | EN/TR status ve health-check mesajlari | Reconnecting/FAIL guidance metinleri ve parity korunumu |
| tauri-plugin-store | `2.x` | `lastSuccessfulPort` devamlılıgı | Auto-recovery hedef portu secimi ve oturumlar arasi hatirlama |
| Vitest | `3.x` | Controller/unit davranis testleri | Retry/backoff, mutual exclusion, health result mapping dogrulama |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Invoke tabanli polling + controller orchestration | Rust->frontend event stream | Event modeli mumkun ama faz kapsaminda gereksiz ek karmasiklik ve lifecycle cleanup riski getirir |
| Mevcut status card + panel aksiyonlari | Ayri modal/wizard alt-akisi | Kapsam disi UX genislemesi; context kararina aykiri |

**Installation:**
```bash
yarn add @tauri-apps/api
```

## Architecture Patterns

### Recommended Project Structure
```text
src/
├── features/device/
│   ├── useDeviceConnection.ts        # Controller + orchestration states
│   ├── deviceConnectionApi.ts        # invoke contracts for recovery/health
│   └── __tests__/ or *.test.ts       # Recovery + health flow unit tests
├── features/settings/sections/
│   └── DeviceSection.tsx             # Reconnecting + health-check UI surface
├── shared/contracts/
│   └── device.ts                     # Command/status codes and phase contracts
└── locales/{en,tr}/common.json       # EN/TR parity for new status copy

src-tauri/
└── src/commands/device_connection.rs # Recovery-health backend command support
```

### Pattern 1: Single-Operation Controller Gate
**What:** Controller seviyesinde ayni anda tek aktif operasyon (manual connect, auto-recovery, health check) kurali.
**When to use:** Recovery ve health-check cakisabilecek her durumda.
**Example:**
```typescript
// Source: existing project pattern
if (!state.selectedPort || state.isScanning || state.isConnecting) {
  return;
}
```

### Pattern 2: Managed Rust State for Connection Snapshot
**What:** Tauri `manage` + `State<Mutex<T>>` ile son bilinen baglanti durumunu merkezi tutma.
**When to use:** Commandlar arasi baglanti/health durumunu tutarli paylasmak icin.
**Example:**
```rust
// Source: https://v2.tauri.app/develop/state-management/
#[tauri::command]
fn increase_counter(state: State<'_, Mutex<AppState>>) -> u32 {
  let mut state = state.lock().unwrap();
  state.counter += 1;
  state.counter
}
```

### Pattern 3: Step-Based Health Check Contract
**What:** 3 adimli sonuc modeli (visibility -> eligibility -> connect+verify), hem top-level PASS/FAIL hem adim bazli sonuc.
**When to use:** Setup asamasinda tanilanabilir ve yonlendirilebilir health check icin.
**Example:**
```typescript
// Source: phase decision constraints + existing CommandStatus pattern
type HealthStep = "PORT_VISIBLE" | "PORT_SUPPORTED" | "CONNECT_AND_VERIFY";
type HealthStepResult = { step: HealthStep; pass: boolean; code: string; message: string; details?: string };
type HealthCheckResult = { pass: boolean; steps: HealthStepResult[]; checkedAtUnixMs: number };
```

### Anti-Patterns to Avoid
- **Paralel operasyonlar:** Auto-recovery devam ederken manual connect/health check baslatmak yarim kalan ve cakisan statuslar uretir; controller gate zorunlu.
- **Tek sinyalden karar verme:** Sadece port listede gorundu diye connected saymak yanlistir; `available_ports` bunu garanti etmez.
- **Auto-dismiss hata/health fail:** Context kararina aykiri; kullanici yonlendirmesi kaybolur.
- **Teknik detay once, aksiyon sonra:** Kullanici mesaji ve net next-step her zaman oncelikli olmali.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| USB serial port discovery | OS-specific native enumeration code | `serialport::available_ports()` | Cross-platform edge case maliyeti yuksek; proje zaten bu crate ile gidiyor |
| App-wide shared connection state | Custom global singleton lifecycle | Tauri `Builder::manage` + `State<Mutex<_>>` | Tauri'nin resmi ve guvenli state enjeksiyon modeli |
| Event/listener lifecycle yönetimi | Ad-hoc listener registry | `@tauri-apps/api/event` `listen` + `unlisten` (gerekirse) | SPA contextlerinde cleanup unutulursa leak riski yuksek |
| i18n string wiring | Hardcoded EN/TR inline metin | `common.json` locale keys + react-i18next | Parity ve metin yonetimi mevcut standartta korunur |

**Key insight:** Bu fazdaki zorluk "baglan" butonundan cok durum koordinasyonu ve hata semantigi; mevcut stack bu koordinasyonu zaten destekliyor, custom altyapi yazmak riski artirir.

## Common Pitfalls

### Pitfall 1: False-Positive Connectivity
**What goes wrong:** Port listede gorundugu icin bagli varsayilir, ama port kullanilamaz/bosaltilmis olabilir.
**Why it happens:** `available_ports()` sadece envanter verir; availability guarantee vermez.
**How to avoid:** Health check'in 3. adiminda explicit connect + immediate status verify yap.
**Warning signs:** UI "connected" gorunurken baglanti denemelerinde sik `PORT_NOT_FOUND`/I/O hatalari.

### Pitfall 2: Recovery/Manual Action Race
**What goes wrong:** Kullanici manuel baglanirken otomatik recovery de baglanmayi dener.
**Why it happens:** Operation ownership kurali net degil.
**How to avoid:** Controller'da operation token/cancel modeli; manuel aksiyon recovery'yi hemen iptal etmeli.
**Warning signs:** Status kartinda hizli state flip, secili portun beklenmedik degismesi.

### Pitfall 3: Stale Listener / Timer Lifecycle
**What goes wrong:** Component remount sonrasi eski timer/listener calismaya devam eder.
**Why it happens:** SPA ortaminda explicit cleanup atlanir.
**How to avoid:** Tauri eventlerde `unlisten`, interval/retry zamanlayicilarinda `clearTimeout/clearInterval` disiplinli kullan.
**Warning signs:** Cift reconnect denemeleri, beklenmedik duplicate status mesajlari.

### Pitfall 4: Contract Drift Between Rust and TS
**What goes wrong:** Yeni health/recovery code ve alanlar frontend/backendde farkli adla tasinir.
**Why it happens:** Shared contract dosyasi guncellenmeden command response degisimi.
**How to avoid:** `src/shared/contracts/device.ts` once guncelle, sonra API ve command tarafini buna bagla.
**Warning signs:** Runtime invoke parse hatalari, `undefined` status alanlari.

## Code Examples

Verified patterns from official sources:

### Tauri Managed State in Commands
```rust
// Source: https://v2.tauri.app/develop/state-management/
#[tauri::command]
fn increase_counter(state: State<'_, Mutex<AppState>>) -> u32 {
  let mut state = state.lock().unwrap();
  state.counter += 1;
  state.counter
}
```

### Rust to Frontend Event Emission (Optional for this phase)
```rust
// Source: https://v2.tauri.app/develop/calling-frontend/
use tauri::{AppHandle, Emitter};

#[tauri::command]
fn publish_status(app: AppHandle, payload: String) {
  app.emit("device-status", payload).unwrap();
}
```

### Serial Port Enumeration Baseline
```rust
// Source: https://docs.rs/serialport/latest/serialport/fn.available_ports.html
let ports = serialport::available_ports()?;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tauri v1 ecosystem patterns | Tauri v2 `@tauri-apps/api/core` + v2 plugins/state docs | v2 lifecycle (current docs updated 2025) | Phase 3 contracts and command wiring v2 API uzerinden kalmali |
| Connect resultini statik kabul etmek | Bağlanti kosulunu periyodik/check-temelli dogrulamak | serialport crate docs latest | Recovery ve health check icin adim bazli verify zorunlu |

**Deprecated/outdated:**
- "Fire-and-forget status" yaklasimi: unplug/replug senaryolarinda yeterli degil; reconnect gorunurlugu ve bounded retries gerekiyor.

## Open Questions

1. **Connection state backendde ne kadar "canli" tutulacak?**
   - What we know: Mevcut backend `connect_serial_port` icinde handle'i acip dusuruyor, sadece son statusu sakliyor.
   - What's unclear: Faz 3'te persistent open handle gerekecek mi, yoksa step-based verify yeterli mi?
   - Recommendation: Faz 3 kapsaminda once verify+recovery orchestration ile ilerle; persistent stream ihtiyaci Phase 5/6 (real-time send loop) ile birlikte netlestir.

2. **Recovery trigger modeli polling mi event mi olacak?**
   - What we know: Tauri event sistemi mevcut, ama invoke-based akis zaten project standard.
   - What's unclear: Bu faz icin event altyapisinin getirisi complexity'yi justify ediyor mu?
   - Recommendation: Polling + bounded retry ile basla; event modelini sadece polling maliyeti/latency yetersiz kalirsa ekle.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3.x |
| Config file | `vitest.config.ts` |
| Quick run command | `yarn vitest run src/features/device/recoveryFlow.test.ts -t "auto recovers"` |
| Full suite command | `yarn vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONN-03 | Last successful port unplug/replug sonrasi bounded window icinde auto-reconnect attempt ve manual override cancellation | unit (controller orchestration) | `yarn vitest run src/features/device/recoveryFlow.test.ts` | ❌ Wave 0 |
| CONN-04 | User-triggered 3-step health check PASS/FAIL + per-step outcomes ve fail guidance | unit (controller + mapping) | `yarn vitest run src/features/device/healthCheckFlow.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `yarn vitest run src/features/device/recoveryFlow.test.ts src/features/device/healthCheckFlow.test.ts`
- **Per wave merge:** `yarn vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/features/device/recoveryFlow.test.ts` - covers CONN-03 recovery timing, retry stages, manual cancel precedence
- [ ] `src/features/device/healthCheckFlow.test.ts` - covers CONN-04 step model and PASS/FAIL aggregation
- [ ] `src/features/device/deviceStatusCardMapping.test.ts` - verifies reconnecting + health-fail persistent UI status mapping

## Sources

### Primary (HIGH confidence)
- Context7 `/tauri-apps/tauri-docs` - state management (`manage`, `State`, mutex guidance), calling frontend from Rust (events, listener lifecycle)
- Context7 `/serialport/serialport-rs` - available_ports and open/timeout usage patterns
- https://v2.tauri.app/develop/state-management/ - Tauri v2 state lifecycle and mutex guidance (last updated May 7, 2025)
- https://v2.tauri.app/develop/calling-frontend/ - event model, payload scope, unlisten lifecycle (last updated May 12, 2025)
- https://docs.rs/serialport/latest/serialport/fn.available_ports.html - availability caveat for enumerated ports

### Secondary (MEDIUM confidence)
- https://vitest.dev/config/ - config behavior and test command conventions (framework wiring for validation plan)
- Repository codebase files (project-ground truth):
  - `src/features/device/useDeviceConnection.ts`
  - `src/features/settings/sections/DeviceSection.tsx`
  - `src/features/device/deviceConnectionApi.ts`
  - `src-tauri/src/commands/device_connection.rs`
  - `src/shared/contracts/device.ts`

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Mevcut repo dependencyleri + resmi Tauri/serialport dokumaniyla dogrulandi
- Architecture: HIGH - Mevcut Phase 2 patternleri ve Tauri state modeli birbiriyle tutarli
- Pitfalls: MEDIUM-HIGH - Bir kismi resmi dokuman (serialport caveat, listener lifecycle), bir kismi proje-ozel orchestration riski

**Research date:** 2026-03-19
**Valid until:** 2026-04-18
