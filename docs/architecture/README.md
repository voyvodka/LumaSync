# Architecture notes

Why LumaSync is built the way it is. This holds what the code cannot say about itself — the reason
behind a decision, the trap that cost someone an afternoon, what was tried and rejected. Nothing
here restates what the code already shows; that is the code's job.

It exists so that a critical piece of reasoning has somewhere to live other than a twenty-line
comment above a function. **Code comments stay short and point here.**

Files are split by area so that reading about Hue does not mean loading everything about USB
serial. Each one carries its own decisions and its own gotchas together, because someone working
in an area needs both.

## What are you about to do

| If you are… | Read |
|---|---|
| Working on Hue — pairing, streaming, zones, colour | [`hue.md`](hue.md) |
| Working on USB serial, WLED, or any output sink | [`device-output.md`](device-output.md) |
| Touching screen capture, the worker, or anything per frame | [`capture-and-pipeline.md`](capture-and-pipeline.md) |
| Adding or changing a Tauri command, a status code, or persisted state | [`contracts-and-state.md`](contracts-and-state.md) |
| Building for the first time, changing CI, or cutting a release | [`build-and-release.md`](build-and-release.md) |
| Working on the window, the tray, compact mode, or i18n | [`ui-and-shell.md`](ui-and-shell.md) |
| Working on the room-map editor, zone geometry, or channel placement | [`room-map.md`](room-map.md) |
| Chasing a runtime bug with no obvious cause | [`../debugging.md`](../debugging.md), then the area file above |
| About to change something that looks odd | The area file — it may be deliberate, and the reason is recorded |

## Standing constraints

These bind every area, so they are stated once here rather than repeated in each file.

**No outbound telemetry, analytics SDK, or third-party crash reporting** — including the
privacy-first ones. Any feedback path must be user-initiated, user-inspectable, and abortable.
Nothing about the user or their screen ever leaves the machine.

Three outbound calls exist, and they are the whole list. Hue's cloud discovery endpoint, which
has a manual-IP fallback precisely so it can be avoided. WLED discovery, LAN-only
(`commands/wled_discovery.rs`). And the update check, which polls the GitHub Releases endpoint in
`src-tauri/tauri.conf.json` on startup — unconditional today, with no manual fallback. Adding a
fourth is a decision, not an implementation detail.

**The capture-to-output path has a per-frame budget.** A regression in it is a defect, not a
tuning matter. See [`capture-and-pipeline.md`](capture-and-pipeline.md).

**`src/shared/contracts/` is the source of truth** for anything crossing the TypeScript↔Rust
boundary — including over this document. See [`contracts-and-state.md`](contracts-and-state.md).

## Adding to this

A new decision or a newly found trap goes in as it is made or found, not in a later documentation
pass — by then the reason has been forgotten and only the outcome remains.

- **One entry, kept short.** A ledger nobody finishes reading is a ledger nobody uses.
- **Put it in the area file it belongs to.** A new area gets a new file and a row in the table above; do not let one file become the place everything lands.
- **When a decision changes, the document moves before the code does.** A set that drifts stops being trusted, and a set nobody trusts stops being read — at which point it is only cost.
- **Rewrite, do not append.** A changed decision is edited in place. Leaving the old wording beside the new is how a reader follows the stale half — and the stale one is usually the more specific, which makes it the one they follow.
