# LumaSync Debugging Guide

Runtime symptoms — hangs, crashes, mode transitions, capture failures, Hue/USB anomalies, shutdown
deadlocks — are diagnosed from the log, not from the code. Reproduce once, read the file, then open
the area note in [`architecture/`](architecture/README.md).

## Clean restart

```bash
# Kill any running instance, clear the leaked single-instance socket, start fresh
pkill -9 -f "tauri dev" 2>/dev/null; pkill -9 -f "target/debug/lumasync" 2>/dev/null; sleep 2
rm -f /tmp/com_lumasync_app_si.sock
bun run tauri dev > /tmp/lumasync-debug-stdout.log 2>&1 &
```

A killed instance leaves the single-instance socket behind, and the next launch hands off to a
process that no longer exists instead of starting.

## One log file holds everything

`src/main.tsx` wraps `console.log/info/warn/error` and forwards them into `tauri-plugin-log`, so
frontend output lands in the same sink as Rust's `log::info!`/`log::warn!`. On macOS that file is
`~/Library/Logs/com.lumasync.app/lumasync-dev.log` (dev) / `lumasync.log` (release; an older
`LumaSync.log` is the same file on a case-insensitive filesystem). Read the file first; terminal
stdout only helps for crashes before the sink initialises.

- Frontend lines carry the `[LumaSync]` prefix by convention.
- Two sinks are configured (Stdout + LogDir), so a line seen in both places is not duplicate execution.
- Levels are set in `src-tauri/src/lib.rs`, not by `RUST_LOG`: dev is `Debug` for `lumasync_lib`
  with an `Info` floor, release is `Info` globally. Rotation is 5 MB per file, `KeepAll` in dev,
  `KeepOne` in release.
- Remove temporary debug logs before committing.

Patterns worth grepping for:

| Pattern | Meaning |
|---|---|
| `[apply_mode_change]` | Lighting mode activation |
| `[ambilight-worker]` | Screen capture worker lifecycle |
| `[shutdown]` | Quit path — expect `cleanup complete, exiting`, not `watchdog fired` |
| `DTLS entertainment stream established` | Hue streaming connected |
| `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` | The bridge holds a stale session |
| `AMBILIGHT_CAPTURE_PERMISSION_DENIED` | macOS screen recording permission missing |

## Webview devtools

`Cmd + Option + I` on macOS in a dev build. The console shows the same `[LumaSync]` lines the log
file does, plus React warnings that never reach the file.

## Tray behaviour

Walk [`manual/phase-01-tray-checklist.md`](manual/phase-01-tray-checklist.md).
