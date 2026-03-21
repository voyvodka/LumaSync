# Phase 10: Hue Stream Lifecycle - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable users to start Hue entertainment output from mode controls, keep it running with stable lifecycle behavior during normal runtime faults, and stop it cleanly with expected non-stream state restoration. This phase clarifies stream lifecycle behavior, not diagnostics expansion or multi-bridge orchestration.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<specifics>
## Specific Ideas

- User explicitly locked dual-output behavior: users can run whichever targets they choose (USB and Hue together when selected).
- User emphasized preventing unnecessary re-pair prompts after temporary disconnections.
- User requested decision-matrix clarity for runtime fault handling (code family -> action -> CTA).

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/device/useHueOnboarding.ts`: Existing gate/readiness/credential controller can feed Phase 10 Start prerequisites and credential durability policy.
- `src/features/device/hueOnboardingApi.ts`: Typed invoke wrapper pattern already covers Hue commands and status DTOs.
- `src/features/device/hueStatusCard.ts`: Existing status-card mapping pattern can be extended for stream lifecycle states and target-scoped statuses.
- `src/features/settings/sections/DeviceSection.tsx`: Current Hue UI host already includes gate/readiness context and can surface runtime lifecycle states.
- `src-tauri/src/commands/lighting_mode.rs`: Existing runtime lifecycle orchestration pattern (`start/stop/status`, worker lifecycle, coded outcomes) is reusable for Hue stream lifecycle semantics.
- `src-tauri/src/commands/hue_onboarding.rs`: Existing readiness and credential validation outcomes provide inputs for lifecycle gate and recovery branching.

### Established Patterns
- Explicit action-first control model with deterministic state transitions.
- Inline coded status communication with calm, actionable language.
- Persist-and-resume conventions in shell store for continuity behavior.
- Backend as final authority for enforceable runtime gates.
- EN/TR parity expectations for user-facing status and action text.

### Integration Points
- Add Hue stream lifecycle commands under `src-tauri/src/commands/` and register via `src-tauri/src/lib.rs`.
- Extend shared runtime contracts (`src/shared/contracts/*`) to include lifecycle states, SLA/retry visibility fields, and action-hint semantics.
- Integrate mode-control start authority with existing Device/Hue gating signals exposed from onboarding state.
- Extend status mapping and UI surfaces for per-target plus aggregate telemetry/status rendering.
- Update `src/locales/en/common.json` and `src/locales/tr/common.json` for lifecycle/recovery/re-pair matrix-driven copy.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 10-hue-stream-lifecycle*
*Context gathered: 2026-03-21*
