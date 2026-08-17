#!/bin/sh
# Cargo `runner`: re-sign the dev binary with a stable identity before launching it.
# Why: docs/architecture/build-and-release.md, "Keychain prompts in dev".
# Opt-in — a pass-through until `pnpm dev:signing-identity` creates the identity.
set -e

BIN="$1"
[ -n "$BIN" ] || { echo "sign-dev-binary: no binary argument" >&2; exit 64; }
shift

IDENTITY="${LUMASYNC_DEV_SIGNING_IDENTITY:-LumaSync Dev}"

# `runner` wraps `cargo test` too, whose binaries are throwaway and hash-suffixed.
case "$(basename "$BIN")" in
  lumasync)
    if [ "$(uname -s)" = "Darwin" ] &&
       security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
      # `--identifier` is pinned because the requirement is built from it, and
      # Cargo's default (`lumasync-<metadata hash>`) moves with crate metadata.
      # Never fail a launch over signing — unsigned still runs, it just prompts.
      codesign --force --sign "$IDENTITY" \
        --identifier com.lumasync.app.dev "$BIN" 2>/dev/null || true
    fi
    ;;
esac

exec "$BIN" "$@"
