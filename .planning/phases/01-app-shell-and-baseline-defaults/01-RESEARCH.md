# Phase 1: App Shell and Baseline Defaults - Research

**Researched:** 2026-03-19
**Domain:** Tauri v2 tray-first desktop shell + React/TypeScript/Tailwind v4 baseline + first-launch i18n default
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
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

### Deferred Ideas (OUT OF SCOPE)
- Add auto-update in first release (new capability; schedule as a later phase).
- Ensure quit action actively turns LEDs off when runtime output is active (primarily relevant after lighting phases are implemented).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| UX-01 | User can run the app from system tray and open full settings window on demand | Tauri v2 tray APIs, tray menu actions, close-to-tray via `onCloseRequested`, single-instance focus behavior |
| I18N-02 | App defaults to English on first launch | i18next `fallbackLng` and deterministic first-launch language policy using persisted `language` key |
</phase_requirements>

## Summary

Phase 1 should be planned around a Tauri v2-native tray lifecycle, not custom process hacks. The standard path is: create tray icon + menu, wire menu actions to show/focus the settings window, intercept close requests to hide instead of exiting, and enforce single-instance behavior so re-launch focuses existing UI. For startup control, use the official autostart plugin instead of OS-specific scripts.

For persistence, avoid ad-hoc JSON read/write and use official Tauri plugins: store for settings and window-state for size/position restoration. This directly supports requirements like restoring window geometry and one-time hint flags while minimizing edge cases. A monitor-bounds guard is still needed for "off-screen window" recovery because restore-by-itself does not guarantee safe visible placement.

Localization planning must explicitly resolve a requirements conflict before lock: REQUIREMENTS.md says first launch defaults to English (I18N-02), while phase context notes user preference for system locale default. Until resolved, implementation should be planned with a policy switch point. Missing keys should always fall back to English.

**Primary recommendation:** Plan Phase 1 as a Tauri v2 tray-shell slice using official plugins (`single-instance`, `autostart`, `store`, `window-state`) and treat first-launch language default as an explicit decision gate before implementation starts.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Tauri | 2.10.x | Desktop runtime + window/tray lifecycle | Official tray/window APIs and plugin ecosystem for startup/single-instance/state |
| @tauri-apps/api | 2.10.x | Frontend access to tray/window/menu APIs | Required JS bindings for tray/menu/window behavior |
| React | 19.x | Settings SPA UI layer | Locked stack; mature app-shell composition for sidebar/content pattern |
| TypeScript | 5.x | Type-safe UI/state code | Reduces config/state regressions in shell bootstrap |
| Tailwind CSS | 4.2.x | Utility styling system | Locked stack; fast baseline theming/layout without runtime overhead |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tauri-plugin-single-instance | 2.x | Prevent duplicate process; focus existing window | Mandatory for UX-01 second-launch behavior |
| @tauri-apps/plugin-autostart | 2.x | Enable/disable run-at-login | Tray Startup Toggle in Phase 1 menu |
| @tauri-apps/plugin-store | 2.x | Persist shell settings and first-run flags | One-time tray hint, language selection, startup preference |
| @tauri-apps/plugin-window-state | 2.x | Persist/restore window size/position/state | Reopen with remembered geometry |
| i18next + react-i18next | 25.x / 15.x | Runtime language switching + fallback | Language section behavior without restart |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `plugin-store` | custom JSON file IO | More edge cases (atomicity, schema drift, path/permission handling) |
| `plugin-window-state` | custom geometry persistence | Reinvents restore logic; higher risk for off-screen regressions |
| `plugin-autostart` | OS-specific scripts/registry calls | Platform-specific maintenance burden, less portable |

**Installation:**
```bash
yarn add @tauri-apps/api @tauri-apps/plugin-autostart @tauri-apps/plugin-store @tauri-apps/plugin-window-state i18next react-i18next i18next-browser-languagedetector
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── app/                 # shell bootstrap, routes, layout
├── features/tray/       # tray menu models + handlers
├── features/settings/   # sidebar pages: General, Startup/Tray, Language, About/Logs, Device
├── features/i18n/       # i18n init, locale resources, language policy
├── features/persistence/# store keys, defaults, migration guards
└── shared/ui/           # reusable primitives

src-tauri/
├── src/lib.rs           # plugin registration and app lifecycle hooks
└── capabilities/        # plugin permissions (autostart commands etc.)
```

### Pattern 1: Tray-Driven Window Control
**What:** Tray menu and tray click both route to one `showAndFocusSettingsWindow()` path.
**When to use:** Always in tray-first mode to avoid divergent open/focus behavior.
**Example:**
```rust
// Source: https://v2.tauri.app/learn/system-tray/
if let Some(window) = app.get_webview_window("main") {
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();
}
```

### Pattern 2: Close-To-Tray Interception
**What:** Intercept close request and hide window instead of terminating process.
**When to use:** Main settings window close action in tray-first shell.
**Example:**
```typescript
// Source: https://v2.tauri.app/reference/javascript/api/namespacewindow/#oncloserequested
import { getCurrentWindow } from '@tauri-apps/api/window';

await getCurrentWindow().onCloseRequested(async (event) => {
  event.preventDefault();
  await getCurrentWindow().hide();
});
```

### Pattern 3: Single-Instance First Plugin
**What:** Register single-instance plugin first and focus existing main window on second launch.
**When to use:** App startup builder chain.
**Example:**
```rust
// Source: https://v2.tauri.app/plugin/single-instance/
builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
  let _ = app.get_webview_window("main").expect("no main window").set_focus();
}));
```

### Anti-Patterns to Avoid
- **Custom startup registration scripts:** Use official autostart plugin and permissions instead.
- **Multiple open/focus codepaths:** Centralize into one function used by tray click/menu/single-instance callback.
- **Hard-killing app on window close:** Violates tray-first UX and breaks UX-01.
- **Unbounded window restore:** Always validate restored position against monitor bounds.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Persist app settings | DIY JSON persistence service | `@tauri-apps/plugin-store` | Auto-save + typed get/set + fewer IO edge cases |
| Run at login | OS-specific startup scripts | `@tauri-apps/plugin-autostart` | Cross-platform API with explicit permissions |
| Single-instance lock | custom mutex/socket lock | `tauri-plugin-single-instance` | Battle-tested process coordination |
| Window geometry restore | custom size/position serializer | `@tauri-apps/plugin-window-state` + monitor bounds guard | Covers common restore cases and keeps custom logic minimal |

**Key insight:** App-shell lifecycle behavior looks simple but is edge-case heavy; official Tauri plugins remove most cross-platform failure modes.

## Common Pitfalls

### Pitfall 1: Autostart works in dev but fails in packaged app
**What goes wrong:** Startup toggle appears enabled but OS launch registration is blocked.
**Why it happens:** Missing plugin permissions in Tauri capabilities.
**How to avoid:** Add `autostart:allow-enable`, `autostart:allow-disable`, `autostart:allow-is-enabled` in capabilities before wiring UI.
**Warning signs:** API calls fail silently or `isEnabled()` never changes.

### Pitfall 2: Second launch opens duplicate or does nothing visible
**What goes wrong:** UX-01 reliability degrades on repeated app open attempts.
**Why it happens:** Single-instance plugin not registered first, or callback does not focus/show.
**How to avoid:** Register single-instance first in builder and call focus/show path in callback.
**Warning signs:** New process spawn attempts, or hidden existing window remains hidden.

### Pitfall 3: Close button exits app instead of minimizing to tray
**What goes wrong:** Tray-first experience breaks and user assumes app quit.
**Why it happens:** Missing `onCloseRequested` interception with `preventDefault()`.
**How to avoid:** Intercept close on main window and route to hide-to-tray path.
**Warning signs:** Tray icon disappears after close.

### Pitfall 4: Restored window appears off-screen
**What goes wrong:** App seems unresponsive because window is outside visible monitors.
**Why it happens:** Restored position not validated against monitor rectangles.
**How to avoid:** On launch/reopen, validate saved bounds via `availableMonitors()` and recenter when invalid.
**Warning signs:** Process runs but no visible settings window.

### Pitfall 5: First-launch language behavior is inconsistent
**What goes wrong:** App defaults differ between environments.
**Why it happens:** Requirement conflict (English default vs system locale default) and implicit detector behavior.
**How to avoid:** Define explicit first-launch policy + persisted override key before implementation.
**Warning signs:** Fresh installs do not match acceptance criteria.

## Code Examples

Verified patterns from official sources:

### Tray menu item handling (Quit/Open)
```typescript
// Source: https://v2.tauri.app/learn/system-tray/
import { Menu } from '@tauri-apps/api/menu';

const menu = await Menu.new({
  items: [
    { id: 'open-settings', text: 'Open Settings', action: () => showAndFocusSettingsWindow() },
    { id: 'quit', text: 'Quit', action: () => appExit() },
  ],
});
```

### Autostart toggle API
```typescript
// Source: https://v2.tauri.app/plugin/autostart/
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

const enabled = await isEnabled();
if (enabled) await disable();
else await enable();
```

### i18next English fallback baseline
```typescript
// Source: https://www.i18next.com/principles/fallback
i18next.init({
  fallbackLng: 'en',
  resources,
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tauri v1 `SystemTray` API | Tauri v2 `TrayIconBuilder` / `@tauri-apps/api/tray` | Tauri v2 migration cycle | Use v2 APIs only; avoid v1 snippets |
| Manual settings JSON persistence | `@tauri-apps/plugin-store` | Tauri plugins v2 | Lower persistence complexity/risk |
| Ad-hoc startup scripts | `@tauri-apps/plugin-autostart` + capabilities | Tauri plugins v2 | Consistent startup toggle behavior |

**Deprecated/outdated:**
- `SystemTray` (v1 style): replaced by v2 tray API shape (`TrayIconBuilder`/`TrayIcon`).

## Open Questions

1. **I18N-02 conflict resolution (English default vs system locale default)**
   - What we know: REQUIREMENTS.md enforces English first launch; CONTEXT.md records user request for system locale default.
   - What's unclear: Which rule is authoritative for Phase 1 acceptance.
   - Recommendation: Lock one acceptance policy before planning tasks; keep fallback-to-English regardless.

2. **Startup toggle default in Phase 1 scope**
   - What we know: Context says decision belongs in setup flow, but setup wizard is Phase 4.
   - What's unclear: Interim default before setup flow exists.
   - Recommendation: Use deterministic temporary default (`off`) and mark migration path for Phase 4.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | none detected - propose Vitest (latest) + lightweight Tauri smoke harness in Wave 0 |
| Config file | none - see Wave 0 |
| Quick run command | `yarn vitest run src/features/i18n/default-language.test.ts -t first-launch` |
| Full suite command | `yarn vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UX-01 | Tray app stays running; settings can be opened from tray | smoke (manual for now) | `yarn tauri dev` (manual validation checklist) | ❌ Wave 0 |
| I18N-02 | Fresh install defaults to English | unit/integration | `yarn vitest run src/features/i18n/default-language.test.ts -t first-launch` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `yarn vitest run src/features/i18n/default-language.test.ts -t first-launch`
- **Per wave merge:** `yarn vitest run`
- **Phase gate:** Full suite green + manual tray checklist before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `vitest.config.ts` - baseline test runner config
- [ ] `src/features/i18n/default-language.test.ts` - covers REQ-I18N-02
- [ ] `docs/manual/phase-01-tray-checklist.md` - repeatable UX-01 manual smoke steps
- [ ] Framework install: `yarn add -D vitest @testing-library/react @testing-library/jest-dom jsdom`

## Sources

### Primary (HIGH confidence)
- `/tauri-apps/tauri-docs` (Context7) - system tray usage, v2 tray events/menu handling, migration notes
- `https://v2.tauri.app/learn/system-tray/` - tray feature, menu/event patterns, v2 API behavior (last updated Sep 5, 2025)
- `https://v2.tauri.app/plugin/autostart/` - plugin setup, usage, required permissions (last updated Feb 22, 2025)
- `https://v2.tauri.app/plugin/single-instance/` - single-instance setup, "register first" note, focus callback (last updated Nov 3, 2025)
- `/tauri-apps/plugins-workspace` (Context7) - store/window-state/single-instance/autostart plugin APIs
- `https://www.i18next.com/principles/fallback` - `fallbackLng` behavior and language fallback rules
- `https://www.i18next.com/overview/configuration-options` - authoritative options (`lng`, `fallbackLng`, detection option hook)

### Secondary (MEDIUM confidence)
- `/websites/v2_tauri_app` (Context7 index for JS window refs) - `onCloseRequested`, monitor APIs; verified against official v2 domain structure
- `https://tailwindcss.com/docs/installation/using-vite` - Tailwind v4.2 installation and Vite plugin path

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - locked by context and validated against current official docs/plugins
- Architecture: HIGH - directly mapped to official Tauri v2 lifecycle and plugin APIs
- Pitfalls: MEDIUM - mostly official-doc grounded, but some UX failure modes inferred from integration experience

**Research date:** 2026-03-19
**Valid until:** 2026-04-18
