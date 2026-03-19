# Phase 2: USB Connection Setup - Research

**Researched:** 2026-03-19
**Domain:** Tauri v2 + Rust serialport ile USB serial tespit/baglanma akisi
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
### Detection Presentation
- Device screen uses a two-group list: **Supported controllers** first, **Other serial ports** second.
- Each row shows: device name, port identifier, and support status.
- Default sorting prioritizes supported controllers.
- Device section runs auto-scan on open and provides a manual **Refresh** action.
- Refresh keeps the list in place and shows inline scanning state (no full-screen skeleton swap).
- Unsupported ports are still selectable for manual fallback attempts.
- Empty auto-detect state shows clear guidance plus immediate manual port selection path.

### Initial Selection Behavior
- First-time usage: preselect the first supported controller when available.
- Returning usage: if last successful port is present, preselect that same port.
- Setup behavior stays in Device panel flow; no wizard behavior is introduced in this phase.

### Manual Fallback Flow
- Manual selection UI is always visible under detection results.
- Connection attempts are explicit via a **Connect** button (not auto-connect on selection).
- If remembered port is missing, clear selection and show an informative message requiring new selection.
- If a remembered port appears but is now marked unsupported, keep it selected with warning context and allow manual attempt.

### Connection Status Messaging
- Use an inline status card in Device panel as the primary status surface.
- Success messaging is short and calm (quiet-by-default style).
- Error messaging uses human-readable explanation plus short technical code/details.
- Failure states include actionable next steps (refresh, choose another port, retry).

### Port Memory Policy
- Persist last-used port only after a successful connection.
- Successful manual connections should be prioritized on next launch if the same port is present.

### Connect Button Rules
- Connect button is enabled only when a port is selected.
- During active refresh/scanning, Connect is temporarily disabled.
- When already connected to selected port, button label/state becomes connection-aware (for example Connected/Reconnect behavior).
- After failed attempt, user can retry immediately (no forced cooldown).

### Port Loss UX
- If selected port disappears after refresh, clear selection and show calm informational warning.
- Status card should show disconnected state with reason (selected port missing) and direct actions.
- If last successful port reappears, it is automatically reselected.

### Claude's Discretion
- Final microcopy wording for inline status, warnings, and helper text while preserving tone decisions.
- Exact visual treatment of status card and row badges while preserving the agreed information density.

### Deferred Ideas (OUT OF SCOPE)
None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CONN-01 | User can auto-detect supported USB serial LED controllers | `serialport::available_ports()` + `SerialPortType::UsbPort(UsbPortInfo)` ile destekli/desteksiz ayrimi, DeviceSection auto-scan on open + Refresh deseni |
| CONN-02 | User can manually select a serial port when auto-detect fails | Tum portlari listeleyip secilebilir tutma, explicit `Connect` command akisi, secim+durum karti+retry mesajlari |
</phase_requirements>

## Summary

Bu faz icin en dogru plan, mevcut app shell desenini bozmadan Device panelinde iki asamali bir akisi uygulamaktir: once Rust tarafinda port envanteri ve baglanti komutlari, sonra React tarafinda secim/durum/hatirlanan-port UX'i. Kod tabaninda bunun icin dogrudan uyumlu temel zaten var: `DeviceSection` placeholder, `invoke/listen` kopru deseni, `shellStore` ile kalici state, ve EN/TR locale yapisi.

Teknik olarak standart yol `serialport` crate kullanmaktir. `available_ports()` tum portlari verir; `SerialPortInfo.port_type` icinden `SerialPortType::UsbPort(UsbPortInfo)` ile VID/PID/manufacturer/product okunur ve destek kurali burada uygulanir. Dokumantasyona gore listelenen portlar her zaman acilabilir olmayabilir, bu nedenle baglanti denemesi ayrik komut olmali (zaten user karariyla uyumlu: secim auto-connect yapmaz, Connect butonuyla explicit attempt).

Planlama acisindan en kritik nokta: bu fazda "resilience" degil "ilk baglanti" hedefleniyor. Bu nedenle unplug/replug auto-recovery, health check ve surekli watchdog Phase 3'e tasinmali; Phase 2'de sadece scan->secim->connect ve success-sonrasi port memory zinciri tamamlanmali.

**Primary recommendation:** Rust'ta minimal ama net bir `device_connection` command modulu kurup (list/connect/disconnect opsiyonel/get-status), frontendte DeviceSection'i bu komutlarla kontrol eden tek bir state makinesiyle (idle/scanning/ready/connecting/connected/error) uygula.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tauri` | `2.x` (repo: `2`) | Rust command bridge + app runtime | Projede zaten aktif; command/event modeli Device akisina birebir uyuyor |
| `@tauri-apps/api` | `^2` | Frontend `invoke/listen` | Mevcut tray/shell koprusu ayni API ile calisiyor |
| `serialport` (Rust crate) | `4.9.0` | Port listeleme, USB metadata, port acma | Cross-platform standard crate; USB metadata alanlari dogrudan destekli |
| `serde` | `1.x` | Command response/request serialization | Tauri command donus modelleri icin zorunlu standart |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@tauri-apps/plugin-store` | `^2.4.2` (repo mevcut) | Last successful port persistence | Sadece successful connection sonrasinda yazmak icin |
| `react` + `typescript` | `19.1.x` + `~5.8` | Device panel state/UI | DeviceSection icindeki secim, refresh, status karti icin |
| `vitest` | `^3.0.0` | Unit tests | Device mapping/state reducer logic testleri icin |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Rust `serialport` | Frontend/Node serial package | Tauri runtime ile iki farkli process/bridge karmasikligi; gereksiz |
| Command tabanli explicit connect | Event-first otomatik baglanti | User kararina ters; hata/yeniden deneme kontrolu zayiflar |
| Plugin bazli "genel serial" arayisi | Dogrudan Rust crate | Ek plugin bagimliligi yerine sade ve denetlenebilir kontrol |

**Installation:**
```bash
cargo add serialport
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── features/device/                  # Device panel state + command adapters
│   ├── deviceConnectionApi.ts        # invoke wrappers (list/connect/status)
│   ├── useDeviceConnection.ts        # UI state machine hook
│   └── types.ts                      # frontend DTO mirrors
├── features/settings/sections/       # DeviceSection UI
│   └── DeviceSection.tsx
└── shared/contracts/
    └── device.ts                     # command names, status enums, keys

src-tauri/src/
├── commands/
│   └── device_connection.rs          # serial list/connect commands
└── lib.rs                            # command registration + existing shell setup
```

### Pattern 1: Command-First Device Operations
**What:** Port listesi ve connect isleri frontendten `invoke` ile cagirilan Rust commands olsun.
**When to use:** Her scan/refresh/connect aksiyonunda.
**Example:**
```rust
// Source: https://v2.tauri.app/develop/calling-rust/
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicePortDto {
    port_name: String,
    is_supported: bool,
    vid: Option<u16>,
    pid: Option<u16>,
    manufacturer: Option<String>,
    product: Option<String>,
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<DevicePortDto>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mapped = ports.into_iter().map(|p| {
        use serialport::SerialPortType;
        let (vid, pid, manufacturer, product, is_supported) = match p.port_type {
            SerialPortType::UsbPort(info) => {
                let supported = matches!((info.vid, info.pid), (0x1A86, 0x7523) | (0x0403, 0x6001));
                (Some(info.vid), Some(info.pid), info.manufacturer, info.product, supported)
            }
            _ => (None, None, None, None, false),
        };
        DevicePortDto {
            port_name: p.port_name,
            is_supported,
            vid,
            pid,
            manufacturer,
            product,
        }
    }).collect();

    Ok(mapped)
}
```

### Pattern 2: Explicit Connect Attempt (No Auto-Connect)
**What:** Port secimi sadece secimi degistirir; baglanti yalniz `Connect` ile denenir.
**When to use:** CONN-02 fallback ve error/Retry davranisi.
**Example:**
```typescript
// Source: https://v2.tauri.app/develop/calling-rust/
import { invoke } from "@tauri-apps/api/core";

export async function connectSerialPort(portName: string) {
  return invoke("connect_serial_port", { portName });
}
```

### Pattern 3: Remember Last Successful Port Only
**What:** Persistence sadece success sonrasinda guncellenir.
**When to use:** Connect response success oldugunda.
**Example:**
```typescript
// Source: existing project pattern in src/features/persistence/shellStore.ts
import { shellStore } from "../persistence/shellStore";

export async function persistLastPortOnSuccess(portName: string) {
  // after extending ShellState with `lastSuccessfulPort?: string`
  await shellStore.save({ lastSuccessfulPort: portName });
}
```

### Anti-Patterns to Avoid
- **Auto-connect on selection:** User kararina aykiri ve hatali portta kontrolsuz retry yaratir; secim ve connect'i ayri tut.
- **Sadece "supported" portlari gostermek:** Manual fallback gereksinimini bozar; unsupported grubu her zaman secilebilir kalmali.
- **Port adindan destek cikarimi (regex-only):** `COMx`/`tty*` adlari guvenilir kimlik degil; USB VID/PID metadata kullan.
- **Refresh sirasinda full-screen loading swap:** Karara aykiri; inline scanning state kullan.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Serial port enumeration | OS-specific COM/tty native code | `serialport::available_ports()` | Platform farklarini ve edge-case'leri crate yonetir |
| USB metadata parsing | Custom vendor/product extraction | `SerialPortType::UsbPort(UsbPortInfo)` | VID/PID/manufacturer/product zaten typed gelir |
| Frontend↔Rust IPC | Custom window message bus | Tauri `#[tauri::command]` + `invoke` | Type-safe ve mevcut app pattern'iyle uyumlu |
| Port memory storage | Ayrik JSON dosya yonetimi | `@tauri-apps/plugin-store` pattern (`shellStore`) | Mevcut persistence deseni korunur, migration riski azalir |

**Key insight:** Bu fazin karmasikligi UI'den cok "dogru yerde dogru abstraction" secimidir; custom IO/IPC kodu yazmak Phase 2 hedefini hizlandirmak yerine hata yuzeyini buyutur.

## Common Pitfalls

### Pitfall 1: "Listede gorunuyor" = "baglanilabilir" varsayimi
**What goes wrong:** Kullanici port gorur ama connect fail olur, UX tutarsizlasir.
**Why it happens:** `available_ports()` dokumantasyonu, listelenen portun mutlaka mevcut/available olacagini garanti etmez.
**How to avoid:** Listing ve connect'i ayri command yap; connect hatasini kod+insan okunur mesajla dondur.
**Warning signs:** Siklikla "port busy"/"permission denied" hatalari.

### Pitfall 2: Supported listesi yalnizca port adina dayanmak
**What goes wrong:** Yanlis pozitif/negatif destek tespiti.
**Why it happens:** `COM3` veya `/dev/ttyUSB0` cihaz tipini tek basina anlatmaz.
**How to avoid:** USB tipinde VID/PID tabanli allowlist uygula; metadata yoksa "other" grubuna dusur.
**Warning signs:** Ayni cihaz farkli port adiyla bazen supported bazen unsupported gorunuyor.

### Pitfall 3: Connect/Refresh yarisi (race condition)
**What goes wrong:** Refresh sirasinda secilen port kaybolup stale state ile connect denenir.
**Why it happens:** UI state gecisleri tek merkezde yonetilmiyor.
**How to avoid:** Device state machine kullan (`scanning` durumunda Connect disable); refresh biterken secim-validasyon yap.
**Warning signs:** "Selected port missing" mesaji olmadan bos/secimsiz connect attempt.

### Pitfall 4: Last port'u basarisiz denemede kalici yazmak
**What goes wrong:** Uygulama sonraki acilista sorunlu porta "yapiskan" olur.
**Why it happens:** Persist tetigi attempt aninda atiliyor.
**How to avoid:** Sadece success response sonrasinda persist et.
**Warning signs:** Kullanici hic basarili baglanmamis porta her acilista otomatik secim donuyor.

## Code Examples

Verified patterns from official sources:

### Enumerate Serial Ports with USB Metadata
```rust
// Source: https://docs.rs/serialport/latest/serialport/fn.available_ports.html
// Source: https://docs.rs/serialport/latest/serialport/struct.SerialPortInfo.html
// Source: https://docs.rs/serialport/latest/serialport/enum.SerialPortType.html
let ports = serialport::available_ports().map_err(|e| e.to_string())?;
for port in ports {
    match port.port_type {
        serialport::SerialPortType::UsbPort(info) => {
            println!("{} {:04x}:{:04x}", port.port_name, info.vid, info.pid);
        }
        _ => {
            println!("{} (non-usb or unknown)", port.port_name);
        }
    }
}
```

### Open a Selected Port Explicitly
```rust
// Source: https://docs.rs/serialport/latest/serialport/fn.new.html
// Source: https://docs.rs/serialport/latest/serialport/struct.SerialPortBuilder.html
use std::time::Duration;

let _port = serialport::new("COM3", 115_200)
    .timeout(Duration::from_millis(300))
    .open()
    .map_err(|e| e.to_string())?;
```

### Frontend Invoke Pattern
```typescript
// Source: https://v2.tauri.app/develop/calling-rust/
import { invoke } from "@tauri-apps/api/core";

type ConnectResult = { ok: boolean; code?: string; message?: string };

export async function connectSelectedPort(portName: string): Promise<ConnectResult> {
  return invoke<ConnectResult>("connect_serial_port", { portName });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Port adina gore heuristic detection | USB metadata (VID/PID + optional manufacturer/product) | serialport modern API (4.x) | Destekli cihaz siniflandirmasi daha guvenilir |
| UI seciminde implicit connect | Explicit `Connect` action + clear status card | Modern desktop setup UX standardi | Retry, hata mesaji, fallback kontrolu daha net |
| Ad-hoc persistence files | Structured app store (plugin-store) | Tauri v2 plugin ekosistemi | Migration ve test kolayligi artar |

**Deprecated/outdated:**
- "Listelenen port kesin baglanir" varsayimi: `available_ports()` bunu garanti etmez; connect her zaman runtime check gerektirir.

## Open Questions

1. **Destekli controller allowlist'i hangi VID/PID setiyle baslayacak?**
   - What we know: Teknik altyapi VID/PID tabanli filtreyi destekliyor.
   - What's unclear: v1 icin resmi "supported controllers" listesi net degil.
   - Recommendation: Plan Wave 0'a `SUPPORTED_CONTROLLER_IDS` sabitini (kolay genisletilebilir) ekle; ilk sette en az CH340 (`1A86:7523`) ve FTDI (`0403:6001`) ile basla, ileride config-driven hale getir.

2. **Disconnect command bu fazda zorunlu mu?**
   - What we know: Gereksinim Phase 2'de ilk baglantiya odakli, recovery Phase 3.
   - What's unclear: UI'da "Connected/Reconnect" label davranisi icin `disconnect` gerekiyor mu.
   - Recommendation: En azindan internal `reconnect` path'i destekle; ayrik Disconnect butonu Phase 3'e kalabilir.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^3.0.0` |
| Config file | `vitest.config.ts` |
| Quick run command | `yarn vitest run src/features/device/**/*.test.ts` |
| Full suite command | `yarn vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONN-01 | Auto-detect sonucunda supported/other gruplama ve siralama dogru | unit | `yarn vitest run src/features/device/portClassification.test.ts -t "groups supported ports first"` | ❌ Wave 0 |
| CONN-02 | Auto-detect fail olsa da manual port secip explicit connect denenebiliyor | unit | `yarn vitest run src/features/device/manualConnectFlow.test.ts -t "manual fallback connect"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `yarn vitest run src/features/device/**/*.test.ts`
- **Per wave merge:** `yarn vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/features/device/portClassification.test.ts` - CONN-01 port grouping/sorting kurallari
- [ ] `src/features/device/manualConnectFlow.test.ts` - CONN-02 manual fallback + connect button kurallari
- [ ] `src/features/device/selectionMemory.test.ts` - successful-only persistence policy

## Sources

### Primary (HIGH confidence)
- Context7 `/tauri-apps/tauri-docs` - Tauri command registration, invoke, error handling, event/listener lifecycle
- https://v2.tauri.app/develop/calling-rust/ - command/invoke resmi kullanimi (updated Nov 19, 2025)
- https://v2.tauri.app/develop/calling-frontend/ - event sistemi ve performans sinirlari (updated May 12, 2025)
- https://v2.tauri.app/security/capabilities/ - capability davranisi, default command exposure notu (updated Aug 1, 2025)
- https://docs.rs/serialport/latest/serialport/fn.available_ports.html - port listeleme ve garanti siniri
- https://docs.rs/serialport/latest/serialport/struct.SerialPortInfo.html - `port_name` + `port_type`
- https://docs.rs/serialport/latest/serialport/enum.SerialPortType.html - `UsbPort/PciPort/BluetoothPort/Unknown`
- https://docs.rs/serialport/latest/serialport/struct.UsbPortInfo.html - VID/PID/manufacturer/product alanlari
- https://docs.rs/serialport/latest/serialport/fn.new.html - port builder ile open pattern
- https://docs.rs/serialport/latest/serialport/struct.SerialPortBuilder.html - timeout ve open ayarlari
- https://crates.io/api/v1/crates/serialport - guncel crate surumu `4.9.0` (updated 2026-03-16)

### Secondary (MEDIUM confidence)
- Context7 `/serialport/serialport-rs` - basic examples (listeleme ornegi var, detay sinirli)

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - repo bagimliliklari + resmi Tauri/serialport kaynaklariyla dogrulandi.
- Architecture: HIGH - mevcut proje patternleri (`invoke`, `shellStore`, DeviceSection host) ve resmi command modeli uyumlu.
- Pitfalls: MEDIUM - kritik maddeler resmi dokumanla destekli; bazi UX race-condition maddeleri proje-ozel cikarim.

**Research date:** 2026-03-19
**Valid until:** 2026-04-18
