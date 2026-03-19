# I18N Phase 1 Alignment Note

**Created:** 2026-03-19
**Phase:** 01-app-shell-and-baseline-defaults
**Relevant requirement:** I18N-02

---

## Conflict Identified

### The Tension

| Source | Position |
|--------|----------|
| **01-CONTEXT.md** (user preference) | "Use system locale as first-launch default" |
| **REQUIREMENTS.md I18N-02** (binding) | "User sees English on first launch with no saved language" |

These two sources conflict on the first-launch default language.

---

## Resolution: Requirements Win for Phase 1

**Decision:** `REQUIREMENTS.md I18N-02` is the binding acceptance criterion for Phase 1 delivery. The context preference is captured as intent for a future phase.

**Rationale:**
- REQUIREMENTS.md is the contractual specification; CONTEXT.md captures user preferences gathered during discussion.
- Overriding a binding requirement without explicit user approval would create an untested, undocumented deviation from the acceptance criteria.
- The implementation difference (English vs. system locale) is a one-line swap, making deferral risk-free.

---

## Source-of-Truth Precedence (Phase 1)

```
REQUIREMENTS.md  (I18N-02)       ← Authoritative for Phase 1 delivery
       ↑
ROADMAP.md       (Phase 1 AC)    ← Confirms I18N-02 as Phase 1 acceptance criterion
       ↑
01-CONTEXT.md    (preference)    ← User intent, captured for future migration
```

---

## Implementation

The conflict is handled in `src/features/i18n/languagePolicy.ts`.

The section marked `ENFORCE_ENGLISH_FIRST_LAUNCH` hard-returns `"en"` on first
launch to satisfy I18N-02. The module header documents the exact migration path.

---

## Future Migration Path

When I18N-02 is revised (or a new requirement captures system-locale preference),
the complete change is:

**File:** `src/features/i18n/languagePolicy.ts`

**Replace the `ENFORCE_ENGLISH_FIRST_LAUNCH` block:**

```typescript
// Before (Phase 1 — I18N-02 compliant):
return DEFAULT_LANGUAGE;

// After (system-locale default):
const systemLocale = navigator.language.split('-')[0]; // e.g. "tr"
return SUPPORTED_LANGUAGES.includes(systemLocale as SupportedLanguage)
  ? (systemLocale as SupportedLanguage)
  : DEFAULT_LANGUAGE;
```

**Prerequisite:** Update or add a requirement that captures "user sees system
locale on first launch" as an acceptance criterion. Revise `I18N-02` or add
`I18N-03`. Update ROADMAP.md phase acceptance criteria accordingly.

---

## Test Coverage

`src/features/i18n/default-language.test.ts` proves I18N-02 compliance:

| Test | Behavior verified |
|------|------------------|
| Test 1 | First launch (no saved language) → `"en"` |
| Test 2 | Persisted `"tr"` → `"tr"` |
| Test 3 | Unknown locale → `"en"` fallback |

---

*This document is the canonical record of the Phase 1 i18n requirements vs. context preference conflict.*
