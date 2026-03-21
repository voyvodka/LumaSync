# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-03-21
**Phases:** 8 | **Plans:** 40 | **Sessions:** 40

### What Was Built
- Tray-first desktop shell with settings lifecycle and first-launch language baseline
- USB connection setup, reconnect health workflow, and deterministic status UX
- Calibration wizard + advanced editor + live pattern validation with parity hardening
- Core lighting modes, adaptive runtime quality, telemetry panel, EN/TR parity, and approved 60-minute stability gate

### What Worked
- Requirement-driven phase breakdown kept scope clear and testable.
- Wave-based execution + plan checker loop reduced late-stage ambiguity.

### What Was Inefficient
- Mid-milestone roadmap/progress metadata drift required repeated docs sync.
- Milestone completion automation under-reported tasks/accomplishments and needed manual correction.

### Patterns Established
- Evidence-first closure pattern: UAT -> VERIFICATION -> REQUIREMENTS sync.
- Shared contracts first (TS/Rust parity) before UI/runtime wiring.

### Key Lessons
1. Gate phases should lock binary pass/fail criteria early to avoid subjective closeout decisions.
2. Keep roadmap progress tables continuously updated to prevent archive-time reconciliation work.

### Cost Observations
- Model mix: mostly sonnet-driven execution with verifier/checker support
- Sessions: 40
- Notable: small atomic commits kept rollback risk low and verification traceability high.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 40 | 8 | Wave-based execution + verification-gated closure stabilized delivery flow |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.0 | Phase-level regression + UAT gates | Requirement coverage 18/18 | Core runtime/features shipped without heavy new framework dependency |

### Top Lessons (Verified Across Milestones)

1. Contract-first planlar (shared IDs/types) integration riskini belirgin sekilde azaltir.
2. Human-checkpoint gerektiren fazlarda runbook + kanit semasi olmazsa kapanis kalitesi duser.
