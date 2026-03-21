# Phase 8: Stability Gate - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Validate that the current system can run continuously for 60 minutes without crash and without requiring manual restart to restore normal operation. This phase is a release gate for reliability verification, not a feature-expansion phase.

</domain>

<decisions>
## Implementation Decisions

### Stability Run Profile
- Run uses an Ambilight-weighted workload, with short planned Solid/Off transitions.
- Screen content should be mixed (high motion, static scenes, and normal desktop transitions), not a single synthetic pattern.
- Include one controlled unplug/replug scenario during the run.
- Telemetry observations are recorded every 10 minutes (0/10/20/30/40/50/60).

### Pass/Fail Gate Rules
- Any app crash or freeze is an immediate FAIL.
- The planned unplug/replug must auto-recover without manual restart; otherwise FAIL.
- Short-lived telemetry quality dips are tolerated, but sustained degradation that does not recover is FAIL.
- If app stays open but Ambilight output stops and needs manual restart/manual mode reset, mark FAIL.

### Evidence Package
- Use a structured UAT-style table plus a clear final summary decision.
- Record telemetry snapshots at each 10-minute checkpoint (capture FPS, send FPS, queue health).
- Screenshots/video are optional on pass, but required when a failure or suspicious behavior is observed.
- Minimum failure incident record must include timestamp, active test step, and user-visible impact.

### Session Flow
- Execute as a single uninterrupted 60-minute session (one timer).
- Run the controlled unplug/replug in the middle window (20-40 minute interval).
- Use hard-stop behavior for critical failures (crash/freeze/manual-restart-needed).
- Final result label must be explicit: APPROVED or GAPS_FOUND.

### Claude's Discretion
- Exact UAT file naming and placement strategy for this phase.
- Exact wording of checklist rows and telemetry checkpoint table columns.
- Whether additional non-blocking diagnostics are captured on pass (as long as required evidence remains unchanged).

</decisions>

<specifics>
## Specific Ideas

- Keep the gate strict on real reliability outcomes, not just process completion.
- Prefer repeatable, timestamped evidence that can be compared across reruns.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/telemetry/ui/TelemetrySection.tsx`: Existing telemetry surface with polling can serve as the operator-facing checkpoint source during the 60-minute run.
- `src-tauri/src/commands/runtime_telemetry.rs`: Provides stable capture/send/queue snapshot contract for checkpoint evidence.
- `src/features/settings/sections/AboutLogsSection.tsx`: Existing logs/about surface can be extended or referenced for run diagnostics context.
- `.planning/phases/04-calibration-workflow/04-HARDWARE-UAT.md` and `.planning/phases/05-core-lighting-modes/05-HARDWARE-UAT.md`: Reusable UAT artifact style (environment, matrix, test cases, pass/fail table).

### Established Patterns
- Verification reports already use explicit status contracts (`passed`, `human_needed`, `gaps_found`) and requirement mapping.
- Prior hardware validation artifacts use requirement-to-test mapping and final binary decision language.
- Shell/settings architecture is section-contract driven (`src/shared/contracts/shell.ts`), enabling consistency if a stability-oriented UX touchpoint is needed.

### Integration Points
- Phase gate evidence should connect to `.planning/phases/08-stability-gate/*-UAT.md` and `08-VERIFICATION.md` for final closeout.
- Requirement traceability must explicitly close `QUAL-04` in `.planning/REQUIREMENTS.md` through the phase-completion flow.
- Runtime behavior under test is centered around current Ambilight pipeline in `src-tauri/src/commands/lighting_mode.rs` plus telemetry snapshot reads.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 08-stability-gate*
*Context gathered: 2026-03-21*
