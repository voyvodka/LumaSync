#!/usr/bin/env bash
#
# macos-swift-runtime.sh — guard against the issue #115 launch crash.
#
# Given a Mach-O binary (the built `lumasync`), assert two invariants that
# together guarantee libswift_Concurrency resolves to the system copy at
# launch on any macOS 12+ machine, rather than back-deploying to an @rpath
# that only exists on the build machine's Xcode toolchain:
#
#   (a) LC_BUILD_VERSION minos >= 12.0
#   (b) no load command references @rpath/libswift_Concurrency
#
# Either failure exits non-zero so CI/release fails loudly instead of
# shipping a binary that aborts at launch on users' machines.
#
# Usage: macos-swift-runtime.sh <path-to-macho-binary>
#
# For a universal (fat) binary, `otool` reports one LC_BUILD_VERSION per
# arch slice; every slice must satisfy (a), so we check every minos seen.
#
# Portable to macOS's stock bash 3.2 (no `mapfile`, no associative arrays).

set -euo pipefail

BIN="${1:?usage: macos-swift-runtime.sh <binary>}"

if [ ! -f "$BIN" ]; then
  echo "FAIL: binary not found: $BIN" >&2
  exit 1
fi

echo "Verifying Swift runtime linkage of: $BIN"

# Minimum required deployment target. Keep in sync with
# tauri.conf.json minimumSystemVersion and .cargo/config.toml.
REQ_MAJOR=12
REQ_MINOR=0

# --- (a) minos >= 12.0 across every LC_BUILD_VERSION slice ---------------
# otool prints lines like:  "    minos 12.3"  (one per arch in a fat binary).
MINOS_LINES="$(otool -l "$BIN" | awk '/^[[:space:]]*minos[[:space:]]/ {print $2}')"

if [ -z "$MINOS_LINES" ]; then
  echo "FAIL: no LC_BUILD_VERSION/minos found in $BIN" >&2
  exit 1
fi

while IFS= read -r MINOS; do
  [ -z "$MINOS" ] && continue
  MAJOR="${MINOS%%.*}"
  REST="${MINOS#*.}"
  if [ "$REST" = "$MINOS" ]; then MINOR=0; else MINOR="${REST%%.*}"; fi
  # Strip any non-numeric remainder defensively.
  MAJOR="$(printf '%s' "$MAJOR" | tr -cd '0-9')"
  MINOR="$(printf '%s' "$MINOR" | tr -cd '0-9')"
  : "${MAJOR:=0}" "${MINOR:=0}"

  if [ "$MAJOR" -lt "$REQ_MAJOR" ] || { [ "$MAJOR" -eq "$REQ_MAJOR" ] && [ "$MINOR" -lt "$REQ_MINOR" ]; }; then
    echo "FAIL: minos $MINOS < required ${REQ_MAJOR}.${REQ_MINOR} — would back-deploy libswift_Concurrency to @rpath (issue #115)" >&2
    exit 1
  fi
  echo "  OK: minos $MINOS (>= ${REQ_MAJOR}.${REQ_MINOR})"
done <<EOF
$MINOS_LINES
EOF

# --- (b) no @rpath reference to libswift_Concurrency ---------------------
# A healthy link bakes the absolute /usr/lib/swift/libswift_Concurrency.dylib.
# Any @rpath/libswift_Concurrency anywhere in the load commands is the crash.
if otool -l "$BIN" | grep -q '@rpath/libswift_Concurrency'; then
  echo "FAIL: binary references @rpath/libswift_Concurrency — dyld will abort at launch on machines without the Xcode Swift toolchain (issue #115)" >&2
  otool -L "$BIN" | grep -i swift_Concurrency >&2 || true
  exit 1
fi
echo "  OK: no @rpath/libswift_Concurrency reference"

# Informational: show the actual swift_Concurrency install name(s).
echo "  swift_Concurrency install name:"
otool -L "$BIN" | grep -i swift_Concurrency | sed 's/^/    /' || echo "    (none linked)"

echo "PASS: Swift runtime linkage is safe."
