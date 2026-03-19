# Phase 2: USB Connection Setup - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver USB serial connection setup so users can quickly detect supported controllers and connect, with manual port fallback when auto-detect misses. This phase covers connection setup UX and flow inside the existing app shell; resilience/health checks remain in Phase 3.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<specifics>
## Specific Ideas

- User explicitly wants remembered-port continuity: "if the app has a previously selected working port, continue from that same port."
- User explicitly confirmed this should be Device-panel driven flow, not setup-wizard behavior for Phase 2.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/features/settings/sections/DeviceSection.tsx`: Existing Device section placeholder is the natural Phase 2 UI host.
- `src/features/settings/SettingsLayout.tsx`: Device section is already part of sidebar navigation contract.
- `src/shared/contracts/shell.ts`: Centralized contract pattern can be extended for connection-related identifiers/state keys.
- `src/features/persistence/shellStore.ts` + `src/features/shell/windowLifecycle.ts`: Established persisted-state pattern for storing user shell preferences can be reused for remembered port behavior.

### Established Patterns
- Tray/shell interactions use clear frontend-bridge boundaries (`invoke`/event listeners) and shared constants.
- UX favors quiet-by-default communication with clear guidance only when needed.
- Existing i18n structure is in place with EN/TR resources and section-based translation keys.

### Integration Points
- Frontend connection UI should integrate into `DeviceSection` and translation files (`src/locales/en/common.json`, `src/locales/tr/common.json`).
- Backend USB/serial operations will integrate via Tauri runtime side (`src-tauri/src/lib.rs`) with command/event bridge patterns already used in Phase 1.
- Tauri permissions/capabilities will likely need extension from `src-tauri/capabilities/default.json` for any new connection operations.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 02-usb-connection-setup*
*Context gathered: 2026-03-19*
