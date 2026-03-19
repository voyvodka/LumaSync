# Phase 1: App Shell and Baseline Defaults - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the tray-first app shell and baseline first-launch behavior for the desktop app. In this phase, users must be able to run the app from tray, open settings reliably, and get consistent startup/default behavior.

</domain>

<decisions>
## Implementation Decisions

### Desktop Shell Baseline
- Tauri is locked as the desktop shell for this project; Electron is out of scope.
- UI layer should use React + TypeScript + Tailwind CSS v4.
- UI interaction model should be no-reload SPA behavior.
- Keep runtime lightweight and stable, consistent with Windows-first priorities.

### Tray Lifecycle Behavior
- Manual app launch should open the settings window.
- If app is configured to run at login/startup, it should start in tray mode.
- Closing the settings window should minimize to tray (not terminate process).
- Tray menu for Phase 1 should include: Open Settings, Status Indicator, Startup Toggle, Quit.
- App should run as single-instance; second launch should focus existing instance.
- On first close-to-tray action, show a one-time educational hint.
- Startup-at-login default should be decided in setup flow (ask user during setup).
- Tray icon should support basic status indication.
- Quit should be immediate and safe; if active LEDs exist in later phases, send best-effort light-off without blocking exit.

### Settings Window Contract
- Settings layout should use sidebar + content panel.
- Window should be resizable with safe minimum constraints.
- Reopen should restore last visited section and last window size.
- If remembered position is outside visible screen bounds, reset to safe centered position.
- Phase 1 sidebar baseline sections: General, Startup/Tray, Language, About/Logs, Device.
- Save behavior (auto-save vs explicit save) is delegated to planner with reliability-first UX.
- Feedback model should be quiet by default, with toast notifications only when needed.

### Localization Baseline
- Language switch control should live in Settings > Language.
- Language changes should apply immediately without app restart.
- Missing translations should fall back to English.
- User requested first-launch default to follow system locale (this conflicts with current I18N-02 requirement and needs requirements/roadmap alignment before final planning lock).

### Claude's Discretion
- Final lightweight state management approach for Phase 1 shell/settings.
- Exact save strategy details for settings edits (while preserving reliability).
- Concrete visual implementation details while keeping "clean technical + premium" direction.
- Apply relevant personal design/stack skills where they improve quality without adding scope.

</decisions>

<specifics>
## Specific Ideas

- "Tauri should be used; Electron is not needed."
- "UI should feel clean technical and premium, not generic utility."
- "Keep app lightweight and stable while still looking polished."
- "If needed, use relevant personal skills during implementation."

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- No product source files detected yet (`src/`, `app/`, or runtime modules are not present).
- Existing inputs are planning/research artifacts only (`.planning/`, `.opencode/`).

### Established Patterns
- Project-level constraints already lock Windows-first, USB-first, tray-first behavior.
- Stack research recommends Tauri + Rust runtime + React/TypeScript UI, now aligned with phase decisions.
- Planning documents should remain in English.

### Integration Points
- Phase 1 shell output becomes the host surface for Phase 2 connection setup.
- Language baseline decisions here must align with Phase 7 full localization rollout.
- Tray status/menu contract established here will be extended by future runtime/device phases.

</code_context>

<deferred>
## Deferred Ideas

- Add auto-update in first release (new capability; schedule as a later phase).
- Ensure quit action actively turns LEDs off when runtime output is active (primarily relevant after lighting phases are implemented).

</deferred>

---

*Phase: 01-app-shell-and-baseline-defaults*
*Context gathered: 2026-03-19*
