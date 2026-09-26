# Design language

What every surface looks like and the accessibility and i18n contract it keeps. The palette is one
deliberate dark theme; the rules below are the ones a new component breaks without anything
failing, so most of them are review responsibilities rather than tests.

The window's shape, the two UI modes and the shared control primitives are in
[`ui-and-shell.md`](ui-and-shell.md); i18n key rules and error parsing are in
[`contracts-and-state.md`](contracts-and-state.md). This file does not repeat them.

## Decisions

**One palette: amber dark (Rev 07), dark-only.** The tokens are the `--lm-*` custom properties in
`src/styles/tokens.css`; read the values there. `:root` sets `color-scheme: dark` so native controls
take the dark system look whatever the OS says, and there is no light variant. `theme.css` gives the
colour tokens Tailwind names (`text-ink`, `bg-panel-2`, `border-line-2`, `ring-amber/60`), and a
component uses those names or the `lm-*` classes — never a hex, never the arbitrary
`[var(--lm-*)]` form where a name exists. `bun run verify:design-tokens`
(`scripts/verify/design-tokens.mjs`, in `check:all`) enforces all three: every bare `var(--lm-*)`
must resolve, no arbitrary form where a named utility exists, and the raw-hex count in `src/` may
only fall (`scripts/verify/hex-literal-baseline.txt`). The hex that remains is SVG and canvas art,
zone identity data and LED test-pattern swatches.

**Chrome is amber in every mode; there is no dynamic accent.** A per-mode accent layer
(`useAccentTheme`, `--accent-color`) was orphaned by a redesign and removed in #358. Where a surface
shows the user's live colour — the hero card, Solid swatches — it reads that colour from its own
state (`useSolidColorDraft` carries the drag draft), not from a global variable. Bringing a global
accent back is a design decision, not a refactor.

**Zone colours are data, not chrome.** `--lm-zone-1..6` identify room-map zones and object types
(`room-map/model/zoneColor.ts`); USB strips map to `--lm-zone-6`, a cyan, and `UsbStripObject`
draws `bg-cyan-500`. Those are not a legacy palette to migrate. `--lm-cyan` is declared and
referenced nowhere; it is not a focus or accent colour.

**What is left of the old palette is small, and it only shrinks.** Slate is gone. Raw Tailwind
`zinc-*` and palette colours survive in the room-map canvas objects and overlays (`room-map/ui/`)
and the dev-only `DevUpdaterMenu`. A file touched for another reason moves to the tokens in the
same change; nothing new starts on the raw palette, and there is no third palette.
`statusBannerConvention.test.ts` keeps the raw `emerald-900/20` / `rose-900/20` banner idiom out of
the files it was removed from — it was once re-planted behind a false "kept for tests" comment.

**No component or icon library.** Tailwind 4, the `lm-*` classes and `src/shared/ui/` only. Icons
are hand-drawn inline SVG in `src/shared/ui/icons.tsx` (`stroke="currentColor"`, `fill="none"`); an
icon used in more than one place goes there, a single-use one may stay inline beside its caller.

**Compact is a separate layout, not a narrow full.** `SettingsLayout` renders `CompactLayout`
(`settings/sections/compact/`) in compact mode, so a control added only to a full-mode section does
not exist for a compact user. Decide which mode it belongs to; do not assume it appears in both.

**The interface is direct and quiet, not corporate.** What the maintainer asked for, settled while
rebuilding LED Setup; apply it to every new screen:

- **Work on the thing itself.** Edit where the object is drawn (numbers on the canvas edges, × and +
  on the edge) rather than in a form of labelled rows beside it.
- **Few words.** No labels above controls, no uppercase or monospace captions, no explanatory
  sentences on screen: values, short names and buttons. An explanation goes in one ⓘ, in plain
  sentence case, a line or two.
- **No enterprise chrome.** No left-border accent on rows, no button stack in the bottom-right, no
  "card of rows". Actions live in one place close to the work (LED Setup's floating dock).
- **Nothing moves under the pointer.** Controls that change label or state keep a fixed width; a
  control that is not needed yet keeps its place instead of shifting the others, and never leaves an
  empty hole — a state it can show instead (the save capsule's "✓ Saved").
- **Typing applies.** A field applies on leaving it, not only on Enter; Esc and out-of-range put the
  old value back.
- **Realistic limits.** Bounds come from the hardware (LED density per metre, screen size), not from
  the backend's safety ceiling.
- **One accent at rest.** Amber marks what to do next: at rest only the primary action (and the
  marker the canvas shares) is amber; secondary controls are grey and warm up on hover. A passive
  state reads as text, not as a framed disabled button; its frame and fill arrive with the state that
  needs them. No surface inside a surface — separators group, a tint appears only on hover.
- **Values at rest, controls on intent.** At rest a screen shows values; the controls that change
  them (− + ⛓ × beside a count, where LED #1 can go, adding a stand) appear on hover or focus of the
  thing they act on, and what they act on lights while the rest steps back.
- **Light and fast.** Static canvas, one delegated listener, memoised geometry, hover through CSS on
  a data attribute rather than a render; performance is a requirement, not a polish step.
- **Before building, show options.** Two or three directions with a sketch each, a recommendation,
  then build; iterate on the running app with hot reload.

**Motion is small, light and answers a change.** The maintainer's taste, stated plainly: tiny,
sweet micro-animations, never big ones and never a loop on a button. Each one shows what just
changed and is gone in about a quarter of a second. The patterns are components — reach for them
before writing a transition by hand: `StateSwap`, `PageSwap`, `SpinSwap` and `Popover` in
`src/shared/ui/`, and LED Setup's dock parts (`NumberField`, `PickerList`, `CommitCapsule`,
`AsyncToggle` in `features/calibration/ui/dock/`, feature-agnostic, promoted on a second use):

- **State swap:** both states stay mounted in a fixed-size box and crossfade with a few pixels of
  travel; nothing around them moves (the LED Setup save capsule, "Saved" ⇄ "↶ | Save").
- **Pass, don't blink:** the leaving item keeps moving while it fades (~.2 s), the arriving one
  follows ~40 ms later (~.26–.32 s). They cross in different places, so there is no pile-up and no
  blank moment — a longer gap reads as a flicker (the first-LED name paging with ‹ ›, the direction
  arrow spinning the new way).
- **Land, don't slide:** a mark that moves reappears where it now is with a small scale-in and a
  one-shot ripple, rather than travelling across the stage.
- **Tick:** a number that changes nudges in by ~3 px.
- **One or two things per gesture,** near where the eye already is; the canvas reacting counts as one.
  Long travel across the screen is out (a pick "flying" 80 px into its control was tried and removed).
- **Motion says where it came from:** ‹ › page sideways, a pick from a list that opens above drops in
  from above, a list grows out of the control that opened it (its notch is the scale origin).
- A persistent state is a static cue (a soft halo, a filled dot), not a pulse. Timing comes from the
  motion tokens in `tokens.css` (`--lm-ease-out`, `--lm-ease-leave`, `--lm-ease-land`,
  `--lm-dur-quick/base/slow`, `--lm-dur-follow`), not raw values; direction goes in class names, not
  CSS variables inside keyframes (WebKit is unreliable with those).

## Accessibility

**Focus is an amber ring on `:focus-visible`.** The `--lm-focus-ring`, `-inset` and `-soft` tokens
are box-shadows, so a ring never shifts layout; the utility form is
`focus-visible:ring-2 focus-visible:ring-amber/60`. A button or canvas that shows a ring on every mouse click is wrong — `:focus` is for
text fields, where the browser treats click focus as visible anyway. A ring painted on an element
that opaque children cover is invisible: the room-map editor draws its ring on a `::after` above
them for that reason.

**32 px is the tap-target floor**, for every clickable element. `IconButton` guarantees it and a
name; a hand-rolled control has to guarantee both itself.

**Colour is never the only signal.** A status pairs its colour with text or a shape — the notice and
`Callout` tone dots differ in shape (disc, diamond, ring, square) so they survive forced colours.

**Every animation carries its own `prefers-reduced-motion` guard**, and every chrome surface its own
`@media (forced-colors: active)` rule, in the stylesheet of the component that animates or draws it (Tailwind's
`motion-reduce:` is the inline form). Nothing checks either is present, and forced colours can only
be verified by hand on Windows.

**A modal dialog is `role="dialog"` + `aria-modal="true"` + `aria-labelledby`, with
`useDialogFocus`** (`src/shared/ui/`) trapping focus, closing on Escape through `onClose`, and
returning focus on close — or it is a `ConfirmDialog`, which does all of that. `aria-modal` without
the trap is worse than neither: assistive technology treats the background as inert while Tab still
walks into it. A popover that does not block (`HeroColorCard`'s picker, the room-map shortcut list)
says `aria-modal="false"`. A scrim starts at `var(--lm-titlebar-h)`, never `inset: 0`: covering the
title bar takes the drag region and the window controls with it (`modalScrimLayering.test.ts`).

**Live regions are `polite`.** The one `assertive` region is the error boundary's fallback.

## i18n in components

**Every user-facing string goes through `t()`**, EN and TR in the same change; rich text uses
`<Trans>` (`UpdateModal`, `LightsSection`), never concatenation, and a count uses i18next plural keys
(`key_one` / `key_other` with `{ count }`), never a ternary in code.

**Parity cannot see a hardcoded literal.** An English string written straight into JSX has no key in
either locale, so the parity test and `check:i18n` both pass while a Turkish user sees English
inside Turkish chrome — the room-map rename dialog and the status-bar key hints shipped that way.
Catching it is review's job; no gate can.

**The global error boundary's hardcoded English is deliberate.** It can fire before i18next has
loaded, so it carries fallback copy for that case; everywhere else it is localised.

## Errors and shortcuts

**A swallowed error is gone for good.** `main.tsx` bridges `console.*` into the Rust log sink, so a
logged failure survives in the user's log file and a dropped one leaves nothing to diagnose (the
rule itself is in [`contracts-and-state.md`](contracts-and-state.md)). No lint catches an empty
`catch`. The binding-less ones left in `src/` each carry a comment saying why ignoring is correct;
a new one needs the same, and `rg -nU "catch\s*\{" src` finds them where a one-line grep misses
multi-line blocks.

**Every window is wrapped in an error boundary at its root** (`renderRoot` in `main.tsx`):
`GlobalErrorBoundaryWithI18n`, which logs and offers a real process relaunch, or `TwinErrorBoundary`
for the transparent overlay ([`ui-and-shell.md`](ui-and-shell.md)). A new window goes through the
same function. The boundary reaches Tauri only through `platform/platformApi.ts` and
`shell/launchApi.ts`, which import nothing but `shared/`: the fallback has to render when a feature
module is what threw, so no bridge it uses may pull feature code in.

**No false affordances.** A global shortcut is declared once in `KEYBIND_REGISTRY`
(`shared/contracts/shell.ts`); `useGlobalKeybinds` handles it and `StatusBar` and `ModeStrip` draw
their badges from the same entry, so a badge cannot outlive its handler — before that hook the badges
were decorative. Matching is on `event.code`, because on a Turkish layout `Alt+1` produces `¡` in
`event.key`, and editable targets swallow the key so a rename field is not a mode switch. The
room-map editor's shortcut list is its own. The same rule hides the error boundary's "Show logs"
until the command behind it has answered.

## Gotchas

- **An undefined custom property fails silently.** The declaration is dropped and the element renders unstyled — the room-map zoom controls once lost their focus ring this way. `verify:design-tokens` catches the bare form; the story is in [`testing-and-verification.md`](testing-and-verification.md#the-quietest-failure-css-has).
- **`var(--lm-x, fallback)` passes the gate on purpose, except on a `:root` token.** A fallback is how a property set inline at runtime (`--lm-fill`) says "undefined here is intended". On a `:root` token it can never be used and drifts from the real value, so it fails.
- **A utility always beats an `lm-*` rule**, whatever the selector's specificity, because of the stylesheet layer order — see "Stylesheet layers" in [`ui-and-shell.md`](ui-and-shell.md).
