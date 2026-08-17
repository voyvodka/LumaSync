#!/bin/sh
# One-time macOS setup for `sign-dev-binary.sh`; unrelated to release signing. See
# docs/architecture/build-and-release.md, "Keychain prompts in dev".
# Undo: security delete-identity -c "LumaSync Dev" ~/Library/Keychains/login.keychain-db
set -e

IDENTITY="${LUMASYNC_DEV_SIGNING_IDENTITY:-LumaSync Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Not macOS — nothing to do."
  exit 0
fi

if security find-identity -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "Identity \"$IDENTITY\" already exists — nothing to do."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/req.cnf" 2>/dev/null

# Security.framework cannot read a PKCS#12 written with OpenSSL 3's defaults.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/identity.p12" -passout pass:lumasync -name "$IDENTITY" \
  -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES 2>/dev/null

# `-A` (any program may use the key) buys silence: without it codesign prompts on
# every build, which is the thing this script exists to stop. Throwaway local key.
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P lumasync -A

echo
echo "Created \"$IDENTITY\"."
echo "The next 'pnpm tauri dev' signs the binary with it. macOS asks for the Hue"
echo "keychain entries once more — choose Always Allow, and that grant sticks."
