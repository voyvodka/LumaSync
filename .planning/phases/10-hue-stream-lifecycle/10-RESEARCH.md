# Phase 10: Hue Stream Lifecycle - Research

**Researched:** 2026-03-21
**Domain:** Hue Entertainment runtime lifecycle (start, keep-alive stability, deterministic stop)
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
### Runtime ownership and state boundaries
- Use a single runtime stream owner model with explicit lifecycle states visible in UX: `Idle`, `Starting`, `Running`, `Reconnecting`, `Stopping`, `Failed`.
- Start is idempotent while `Starting/Running` (repeat Start is no-op, not restart).
- User action always wins over automation; user Stop/target action cancels in-flight auto-recovery.

### Start/Stop trigger authority
- Start authority is unified at mode-control layer; Device surface remains preparation/gating surface.
- Stop can be requested from multiple UI surfaces, but all requests route to one shared stop pipeline.
- Final gate decision is backend-owned (UI pre-check can exist, but backend is source of truth).
- Show a lightweight trigger-source hint in status card for user clarity.

### Strict gate minimum conditions
- Hue Start requires all of: selected bridge, valid credentials, selected area, and current stream-ready true.
- While credential state is `validating/unknown`, Start stays disabled.
- Stale readiness is not accepted; readiness must be current at Start time (revalidate required when stale).
- On gate failure, show missing-condition checklist with direct recovery actions.

### Keep-alive, retry/backoff, and timeout SLA
- Use fixed short keep-alive interval in normal runtime.
- Transient failures use bounded exponential retry/backoff (no unbounded retry loop).
- On retry budget exhaustion: transition `Reconnecting -> Failed` with clear next action.
- Surface coded timeout information with retry counter context (remaining/next attempt visibility).

### Transient fault recovery and fallback
- Transient class includes network/jitter/timeout style faults; auth invalidation is not transient.
- During recovery, manual user actions can interrupt and take priority immediately.
- If recovery fails, stop Hue runtime cleanly and expose explicit failed state with next-step actions.
- Re-pair is suggested only when there is explicit auth/credential-invalid evidence.

### USB/Hue output arbitration (dual-output locked)
- USB and Hue can run simultaneously; user can start selected targets together.
- Multi-target Start launches all selected outputs; if one target fails to start, partial success is allowed and healthy targets continue.
- Outputs are independently controllable: stopping one target does not stop the others.
- Persist last selected target set and restore on next session.
- Status visibility is target-scoped (per-target rows) plus aggregate state.
- During transient recovery, controls are target-based (recovering target constrained; healthy targets remain operable).
- Arbitration conflicts must emit coded conflict status with clear user action guidance.

### Stop cleanup semantics
- Stop sequence is deterministic: stream stop first, then state restore to expected non-stream state.
- If stop times out, show partial-stop result and retry action.
- On app quit with active stream, run best-effort non-blocking cleanup before process exit.
- No forced cooldown after stop; immediate restart attempts are allowed.

### Telemetry and status-card contract
- Keep coded status contract (`code + user-facing message + optional details`) as mandatory shape.
- Telemetry must expose both per-target and aggregate runtime health for dual-output mode.
- Status card should include compact retry/backoff progress (remaining attempts + next attempt cue).
- Re-pair recommendation must be represented as explicit action-hint code/flag, not inferred only from free text.

### Credential durability and re-pair decision policy
- Re-pair requires explicit auth-invalid evidence; transient transport faults must not drop directly to `needs_repair`.
- On transient transport faults, preserve credential state and continue retry/reconnect policy.
- Escalation after bounded retries: if auth-invalid evidence appears -> `needs_repair`; otherwise -> failed/manual reconnect flow.
- Exit from `needs_repair` requires successful re-pair (no manual override to valid).

#### Credential Decision Matrix

| Code Family | Evidence Type | Runtime Action | User CTA |
|-------------|---------------|----------------|----------|
| `TRANSIENT_*` (network/timeout/jitter) | Transport instability, no auth-invalid signal | Retry/reconnect with bounded exponential backoff | `Retry` / `Reconnect` |
| `AUTH_INVALID_*` | Explicit unauthorized/invalid credential response | Set `needs_repair`, stop stream safely | `Re-pair` |
| `CONFIG_NOT_READY_*` | Area/config/readiness prerequisites not met | Keep stream stopped, request revalidate/fix config | `Revalidate` / `Adjust Area` |

### Claude's Discretion
- Exact numeric SLA constants (keep-alive interval, retry cap, backoff coefficients, timeout thresholds) while honoring bounded policy.
- Exact naming taxonomy for runtime codes, provided matrix semantics remain stable.
- Visual density/layout of target-level and aggregate status blocks under current Device design language.

### Deferred Ideas (OUT OF SCOPE)
None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| HUE-05 | User can start Hue Entertainment streaming for the selected area from app mode controls. | Start authority at mode controls, backend final gate, idempotent start, and Hue `action:start` control-plane contract are defined. |
| HUE-06 | User can keep Hue stream alive during runtime with stable packet flow and keep-alive behavior. | Single owner lifecycle model, bounded retry/backoff, transient vs auth-invalid split, and continuous stream guidance are defined. |
| HUE-07 | User can stop Hue stream cleanly and restore bridge/device state without manual cleanup. | Shared stop pipeline, deterministic stop order, timeout partial-stop semantics, and app-exit best-effort cleanup are defined. |
</phase_requirements>

## Summary

Phase 10 should be planned as a runtime-lifecycle phase, not a new onboarding phase. The repo already has the right architecture style in `src-tauri/src/commands/lighting_mode.rs`: single runtime owner, explicit stop/start transitions, worker cancel/join, and stable command-shaped results. Reusing this exact pattern for Hue stream lifecycle is the lowest-risk path.

For Hue domain behavior, control-plane and data-plane must be separated. Control-plane start/stop is handled by Hue entertainment configuration action (`start` / `stop`) and status (`active` / `inactive`), while data-plane uses DTLS over UDP 2100 for continuous frames. Evidence from a mirrored Philips Hue Entertainment page (saved from official URL, modified 2024-01-23) plus OpenHue OpenAPI confirms these semantics and key constraints (single active streamer per area, auto-close after inactivity, continuous stream requirement).

Primary planning risk is not implementation complexity, but policy correctness: stale readiness, user-stop priority over auto-reconnect, and false `needs_repair` escalation on transient transport faults. Locked decisions already solve this; plan tasks should enforce them through explicit lifecycle state transitions, coded outcomes, and tests.

**Primary recommendation:** Implement `HueRuntimeOwner` with explicit lifecycle state machine and backend-authoritative start/stop gates, reusing existing mode-runtime command patterns and extending contracts/status mapping for Hue target-scoped runtime telemetry.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tauri` + managed `State` | `2` | Backend command authority and runtime state ownership | Already used in app command system (`app.manage`, `State<'_>`, `invoke_handler`) and officially documented for this exact pattern |
| Rust std sync/thread primitives | stdlib | Worker lifecycle (`cancel`, `join`), owner lock discipline | Existing runtime module already uses this successfully for stable continuous output |
| `reqwest` blocking client | `0.12` | Hue REST control-plane calls (start/stop/check status/readiness) | Already used by Hue onboarding path with same timeout/error model |
| Shared TS contracts (`src/shared/contracts/hue.ts`) | in-repo | Typed code/message/details + lifecycle fields across frontend/backend | Existing project standard for command IDs, status code constants, and persistence-safe shape |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| DTLS client library (Rust) | TBD in Wave 0 spike | Secure Hue stream transport to UDP 2100 | Use when implementing actual frame stream loop |
| Vitest | `^3.0.0` | Fast UI/state mapping tests and mode-control contract tests | Use for frontend lifecycle/status card and guard behavior |
| Cargo test (builtin) | Rust toolchain | Backend lifecycle and retry policy tests | Use for owner transitions, timeout handling, and stop determinism |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| In-repo owner+worker lifecycle pattern | New ad-hoc async task graph | Faster first draft, but higher race risk and less predictable stop behavior |
| Backend final gate | UI-only gate decisions | Simpler UI, but stale readiness and concurrent action races become likely |
| One shared stop pipeline | Surface-specific stop implementations | Lower coupling locally, but cleanup semantics drift and harder to verify |

**Installation:**
```bash
# Existing stack is already present in this repo.
# If a DTLS crate is selected during Wave 0 spike, add it explicitly then.
```

## Architecture Patterns

### Recommended Project Structure
```text
src-tauri/src/commands/
├── hue_stream_lifecycle.rs      # new: owner state machine + start/stop/reconnect
├── hue_onboarding.rs            # existing: bridge/credential/area/readiness inputs
└── lighting_mode.rs             # existing: reference runtime-owner pattern

src/shared/contracts/
└── hue.ts                       # lifecycle state, codes, action-hint additions

src/features/
├── mode/                        # start authority surface
└── device/                      # gate prep + status visualization surface
```

### Pattern 1: Single Owner Lifecycle State Machine
**What:** One runtime owner controls Hue stream worker and all transitions (`Idle`, `Starting`, `Running`, `Reconnecting`, `Stopping`, `Failed`).
**When to use:** All HUE-05/06/07 command flows.
**Example:**
```rust
// Source: src-tauri/src/commands/lighting_mode.rs
struct LightingRuntimeOwner {
    active_mode: LightingModeConfig,
    worker: Option<LightingWorkerRuntime>,
}

impl LightingWorkerRuntime {
    fn stop(self) {
        self.cancel.store(true, Ordering::Relaxed);
        let _ = self.handle.join();
    }
}
```

### Pattern 2: Control Plane First, Stream Plane Second
**What:** Start/stop via entertainment configuration action, then DTLS session and frame stream.
**When to use:** Start, reconnect, stop.
**Example:**
```yaml
# Source: https://api.redocly.com/registry/bundle/openhue/openhue/v2/openapi.yaml?branch=main
EntertainmentConfigurationPut:
  properties:
    action:
      enum: [start, stop]
```

### Pattern 3: Backend-Authoritative Gate with Coded Outcome
**What:** Backend validates strict prerequisites; frontend displays coded status and direct CTA.
**When to use:** Start request, stale readiness, auth/transient split, stop timeout.
**Example:**
```rust
// Source: src-tauri/src/commands/hue_onboarding.rs
pub struct CommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}
```

### Anti-Patterns to Avoid
- **Multiple Hue runtime owners:** leads to duplicate sockets, racey stop/reconnect, and inconsistent UX state.
- **UI-only readiness authority:** allows stale gates and non-deterministic start failures.
- **Unbounded reconnect loop:** violates locked decision and blocks user-priority stop.
- **Implicit repair escalation:** transport failures must not directly force `needs_repair` without auth-invalid evidence.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime transition orchestration | scattered boolean flags | explicit owner state machine | Prevents hidden states and race conditions under reconnect/stop pressure |
| Command error semantics | free-text-only errors | coded `code + message + details (+ action hint)` | Enables deterministic UI behavior, telemetry, and EN/TR parity |
| Stream transport security details | custom DTLS/PSK implementation | maintained DTLS library + protocol constraints | DTLS correctness is easy to get wrong and expensive to debug |
| Retry policy | ad-hoc loops | bounded exponential backoff policy object | Enforces predictable failover and user-priority interruption |

**Key insight:** The expensive failures in this phase come from lifecycle policy drift, not from color-frame generation. Keep lifecycle explicit and centralized.

## Common Pitfalls

### Pitfall 1: Start uses stale readiness
**What goes wrong:** Start is enabled from old readiness result and fails at runtime.
**Why it happens:** No freshness check at start command time.
**How to avoid:** Validate freshness + strict prerequisites in backend before start action.
**Warning signs:** Intermittent start failures with same selected bridge/area.

### Pitfall 2: Auto-reconnect overrides user stop
**What goes wrong:** Stream restarts after user presses stop.
**Why it happens:** Recovery loop is not canceled by manual action.
**How to avoid:** User action cancellation token must preempt reconnect path.
**Warning signs:** `Idle` briefly appears then returns to `Running`.

### Pitfall 3: Stop timeout leaves half-stopped state
**What goes wrong:** Stream transport closes partially, bridge status not restored cleanly.
**Why it happens:** No explicit partial-stop outcome and retry path.
**How to avoid:** Emit coded partial-stop result and keep deterministic retry cleanup action.
**Warning signs:** Immediate restart fails until manual retries.

### Pitfall 4: Transient network fault misclassified as credential failure
**What goes wrong:** User sees unnecessary re-pair CTA.
**Why it happens:** Missing evidence-based auth-invalid decision point.
**How to avoid:** Follow locked decision matrix exactly (`TRANSIENT_*` vs `AUTH_INVALID_*`).
**Warning signs:** Re-pair prompts after short disconnect/jitter without explicit unauthorized response.

## Code Examples

Verified patterns from official/in-repo sources:

### Tauri managed state in commands
```rust
// Source: https://v2.tauri.app/develop/calling-rust
struct MyState(String);

#[tauri::command]
fn my_custom_command(state: tauri::State<MyState>) {
  assert_eq!(state.0 == "some state value", true);
}
```

### Hue entertainment start/stop action contract
```yaml
# Source: https://api.redocly.com/registry/bundle/openhue/openhue/v2/openapi.yaml?branch=main
EntertainmentConfigurationPut:
  type: object
  properties:
    action:
      type: string
      enum:
        - start
        - stop
```

### Existing runtime owner stop discipline
```rust
// Source: src-tauri/src/commands/lighting_mode.rs
fn stop_previous(owner: &mut LightingRuntimeOwner, trace: &mut Option<&mut Vec<&'static str>>) {
    push_trace(trace, "stop_previous");
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Onboarding-only readiness as practical gate | Runtime lifecycle owner with explicit transitions and backend authority | v1.1 Phase 10 target | Enables stable long-running mode instead of one-shot setup |
| Implicit stop behavior | Deterministic stop pipeline with timeout-aware outcomes | Current locked decisions | Makes cleanup observable and recoverable |
| Unstructured failure text | Coded status families with explicit CTA semantics | Established in project + Phase 10 lock | Better user guidance and safer automation interruptions |

**Deprecated/outdated:**
- Treating all disconnects as re-pair needs; only explicit auth-invalid evidence can escalate to `needs_repair`.
- Treating Device panel Start as authority; mode-control + backend gate is authoritative for this phase.

## Open Questions

1. **DTLS crate selection for Rust implementation**
   - What we know: Protocol constraints are clear (DTLS 1.2, PSK identity/value constraints, UDP 2100).
   - What's unclear: Best crate fit for this repo's threading/runtime and maintenance profile.
   - Recommendation: Wave 0 spike task to validate one DTLS crate with a minimal handshake harness.

2. **Exact inactivity/keep-alive numeric constants in current bridge firmware**
   - What we know: Mirrored official page states auto-close after 10s inactivity and recommends continuous streaming.
   - What's unclear: Whether latest bridge firmware behavior differs in edge conditions.
   - Recommendation: Add short verification task on a real bridge before finalizing SLA constants.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust unit tests (`cargo test`) + Vitest `^3.0.0` |
| Config file | `vitest.config.ts` |
| Quick run command | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts` |
| Full suite command | `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HUE-05 | Start Hue stream from mode controls with strict gate + idempotent start | unit (backend) + unit (frontend) | `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle_start -- --exact` | ❌ Wave 0 |
| HUE-06 | Keep stream active with bounded retry/backoff and visible reconnect progress | unit/integration (backend) | `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle_reconnect -- --exact` | ❌ Wave 0 |
| HUE-07 | Deterministic stop and non-stream restoration with timeout partial-stop handling | unit (backend) + unit (frontend mapping) | `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle_stop -- --exact` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `yarn vitest run <target-test-file>` or targeted `cargo test` for touched behavior.
- **Per wave merge:** `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run`.
- **Phase gate:** Full suite green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/hue_stream_lifecycle.rs` unit tests (start gate, idempotency, reconnect budget, stop cleanup)
- [ ] `src/features/device/hueRuntimeStatusCard.test.ts` target-scoped and aggregate status mapping
- [ ] `src/features/mode/state/hueModeRuntimeFlow.test.ts` mode-control start authority and user-stop priority
- [ ] Contract tests for new Hue lifecycle status/code fields in `src/shared/contracts/hue.ts`

## Sources

### Primary (HIGH confidence)
- Context7 `/websites/v2_tauri_app` - Tauri v2 command state management patterns (`manage`, `State`, `invoke_handler`).
- In-repo runtime patterns: `src-tauri/src/commands/lighting_mode.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/hue_onboarding.rs`.
- In-repo requirements/constraints: `.planning/phases/10-hue-stream-lifecycle/10-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`.

### Secondary (MEDIUM confidence)
- OpenHue OpenAPI bundle (current public machine-readable contract): `https://api.redocly.com/registry/bundle/openhue/openhue/v2/openapi.yaml?branch=main`.
- Mirrored Philips Hue Entertainment API page with canonical URL metadata and 2024-01-23 modified time: `https://github.com/herve-er/hue4cpp/blob/60a413be305992f3daf7f0632104109df00078c5/doc/hueApiV2/Hue%20Entertainment%20API%20-%20Philips%20Hue%20Developer%20Program.html`.

### Tertiary (LOW confidence)
- `https://github.com/peter-murray/node-hue-api` entertainment module code as ecosystem implementation reference (useful patterns, not source-of-truth spec).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - strongly grounded in current repo stack and Tauri docs.
- Architecture: HIGH - directly aligned with locked phase decisions and proven in-repo runtime pattern.
- Pitfalls: MEDIUM - behavior is clear, but official Hue portal was login-gated in this environment and required mirrored/secondary verification for some protocol details.

**Research date:** 2026-03-21
**Valid until:** 2026-03-28
