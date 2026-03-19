# Phase 3: Connection Resilience and Health - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver resilient connection behavior for unplug/replug interruptions and a setup-time health check that returns clear pass/fail outcomes. This phase covers recovery flow and connection-condition visibility inside the existing Device panel experience. Calibration, lighting modes, and advanced diagnostics remain out of scope.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<specifics>
## Specific Ideas

- "Session should recover after unplug/replug without forcing app restart" is treated as the core user promise for this phase.
- Health check should feel setup-friendly: explicit, readable, and immediately actionable on failure.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/device/useDeviceConnection.ts`: Existing controller/state-machine pattern can host recovery and health-check orchestration states.
- `src/features/settings/sections/DeviceSection.tsx`: Existing Device panel already has grouped ports, actions, and inline status card surface.
- `src/features/device/deviceConnectionApi.ts`: Existing Tauri bridge for list/connect/get-status can be extended for resilience and health-check flows.
- `src/features/persistence/shellStore.ts`: Existing persisted state pattern already stores `lastSuccessfulPort` and can support recovery continuity.
- `src-tauri/src/commands/device_connection.rs`: Existing serial command layer and shared `SerialConnectionState` provide backend anchor points.

### Established Patterns
- Connection UX is explicit-action first (Phase 2): no implicit connect on simple selection.
- Status communication is inline and quiet-by-default, with actionable guidance when needed.
- Frontend/backend contracts are centralized in shared files and consumed through invoke-based command bridge.
- EN/TR localization parity pattern already exists for Device panel copy.

### Integration Points
- Extend `src/features/device/useDeviceConnection.ts` and `src/features/settings/sections/DeviceSection.tsx` for reconnecting + health-check states.
- Extend `src/features/device/deviceConnectionApi.ts` and `src/shared/contracts/device.ts` for any new command/state contracts.
- Extend `src-tauri/src/commands/device_connection.rs` and command registration in `src-tauri/src/lib.rs` for backend resilience/health operations.
- Update `src/locales/en/common.json` and `src/locales/tr/common.json` with new recovery/health-check copy.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 03-connection-resilience-and-health*
*Context gathered: 2026-03-19*
