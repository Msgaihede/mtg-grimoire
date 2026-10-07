#!/usr/bin/env bash
# Prove `sign-bundle.sh` on keys nobody keeps: it signs, and it refuses what it must.
#
#   bash scripts/android-release/proof.sh <bundle.aab>   # `ci.yml`'s `android` job, over its build
#   bash scripts/android-release/proof.sh --fake         # anywhere with a JDK: a bundle made here
#
# A release is the wrong place to find out that `keytool` words its answer differently or that a
# refusal leaves a file behind, so this runs first — on every pull request that can have changed
# the bundle, and by hand with `--fake`, which needs no Android SDK. Every key is minted with a
# random password in a temporary folder and deleted with it. **Not a secret and not an
# artifact**: nothing this writes is kept.
#
# What it holds the script to:
#
#   1. a bundle signed with a key, held to that key's fingerprint, is written;
#   2. the input is not written to;
#   3. a keystore the fingerprint does not name is refused, and no bundle is left behind;
#   4. an Android debug certificate is refused, with no fingerprint and with its own, and no
#      bundle is left behind;
#   5. an archive that is not a bundle is refused, and no bundle is left behind;
#   6. a bundle that reaches it already signed comes out with one signer — `--fake`'s input is
#      signed first with a debug-shaped key, as Gradle signs the build's;
#   7. the same path given as input and output is refused, and that file is left byte for byte as
#      it was (checked on a copy of the bundle).
#
# Cases 3 to 5 start with a file already at the output path, so "no bundle is left behind" means
# the script deleted it and not merely that it never wrote one.
set -euo pipefail

: "${JAVA_HOME:?JAVA_HOME is not set, so there is no JDK to take keytool from}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
keytool="$JAVA_HOME/bin/keytool"
jar="$JAVA_HOME/bin/jar"
jarsigner="$JAVA_HOME/bin/jarsigner"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() {
  echo "android-sign proof: $*" >&2
  exit 1
}

ANDROID_KEYSTORE_PASSWORD=$(openssl rand -hex 16)
export ANDROID_KEYSTORE_PASSWORD
export ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
export ANDROID_KEY_ALIAS=throwaway
export ANDROID_KEYSTORE="$work/throwaway.keystore"
# The script's summary is a release's to read, not this run's.
export GITHUB_STEP_SUMMARY="$work/summary.md"

# `mint <dname>`: a new key under the alias, replacing whatever the keystore held.
mint() {
  rm -f "$ANDROID_KEYSTORE"
  "$keytool" -genkeypair -keystore "$ANDROID_KEYSTORE" \
    -storepass:env ANDROID_KEYSTORE_PASSWORD -alias "$ANDROID_KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 1 -dname "$1" > "$work/mint.txt" 2>&1 \
    || fail "keytool could not mint a key: $(head -1 "$work/mint.txt")"
}

case "${1:-}" in
  --fake)
    # A bundle's shape and no more: the marker file, a manifest, something large enough to be a
    # library — signed as Gradle signs the build's, so there is a signature to take off.
    mkdir -p "$work/tree/base/manifest" "$work/tree/base/lib/arm64-v8a"
    echo "not a real config" > "$work/tree/BundleConfig.pb"
    echo "not a real manifest" > "$work/tree/base/manifest/AndroidManifest.xml"
    head -c 262144 /dev/urandom > "$work/tree/base/lib/arm64-v8a/libfake.so"
    "$jar" cfM "$work/unsigned.aab" -C "$work/tree" .
    mint "CN=Android Debug,O=Android,C=US"
    # `-sigfile ANDROIDD`, the name Gradle's debug signing gives: the re-sign writes
    # `META-INF/THROWAWA.*` (the alias), so were this signature under that name too, `jarsigner`
    # would overwrite it whether or not the strip had removed anything, and `--fake` would pass
    # with the strip gone.
    "$jarsigner" -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
      -keypass:env ANDROID_KEY_PASSWORD -sigfile ANDROIDD -signedjar "$work/fake.aab" \
      "$work/unsigned.aab" "$ANDROID_KEY_ALIAS" > "$work/presign.txt" 2>&1 \
      || fail "jarsigner could not sign the fake bundle: $(head -1 "$work/presign.txt")"
    bundle="$work/fake.aab"
    ;;
  "") fail "usage: proof.sh <bundle.aab> | --fake" ;;
  *) bundle=$1 ;;
esac
[ -s "$bundle" ] || fail "no bundle at $bundle"

out="$work/signed.aab"
pin="$work/signer.sha256"
# The script announces a refusal as a workflow annotation on its standard output: right at a
# release, noise here, where every refusal is the point. Its standard error stays.
sign() { bash "$HERE/sign-bundle.sh" "${1:-$bundle}" "$out" > /dev/null; }
before=$(sha256sum "$bundle" | cut -d' ' -f1)

# 1, 2 and 6: signed, held to the key's own fingerprint; the input as it was.
mint "CN=throwaway"
"$keytool" -exportcert -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" -file "$work/throwaway.der" > /dev/null 2>&1 \
  || fail "keytool could not export the throwaway certificate"
sha256sum "$work/throwaway.der" | cut -d' ' -f1 > "$pin"
ANDROID_SIGNER_PIN="$pin" sign || fail "a bundle signed with the key its fingerprint names was refused"
[ -s "$out" ] || fail "the signing reported success and wrote no bundle"
[ "$(sha256sum "$bundle" | cut -d' ' -f1)" = "$before" ] || fail "the signing wrote to its input"
# The result, asked of `keytool` here and not taken from the script under test: one signer, and
# it is this key. (With `--fake`, a signature is on the input under another name, so a strip that
# removed nothing leaves two.)
"$keytool" -printcert -jarfile "$out" > "$work/signers.txt" 2>&1 || true
[ "$(grep -c '^Signer #' "$work/signers.txt" || true)" = 1 ] \
  || fail "the signed bundle does not have exactly one signer: $(grep '^Signer #' "$work/signers.txt" | paste -sd ' ')"
signed_by=$(sed -n 's/^[[:space:]]*SHA256: *//p' "$work/signers.txt" | tr -d ':\r' | tr 'A-F' 'a-f')
[ "$signed_by" = "$(cat "$pin")" ] \
  || fail "the signed bundle's certificate is $signed_by, and the throwaway key's is $(cat "$pin")"
rm -f "$out"

# Each refusal below happens before `jarsigner` writes anything, so `$out` would be absent after
# it whether or not `die` removes it. A sentinel is put there first: the assertion after the
# refusal then fails unless the script really deleted what was at `$out`.
sentinel() { echo "left over from an earlier run" > "$out"; }

# 3: another key's fingerprint.
printf '%064d\n' 0 > "$pin"
sentinel
if ANDROID_SIGNER_PIN="$pin" sign; then fail "signed with a key the fingerprint does not name"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"

# 5: an archive that is not a bundle. Before the debug key is minted, so this is refused for
# what it is and not for who would sign it.
mkdir -p "$work/apk"
echo "not a bundle" > "$work/apk/classes.dex"
"$jar" cfM "$work/not-a-bundle.aab" -C "$work/apk" .
sentinel
if sign "$work/not-a-bundle.aab"; then fail "signed an archive with no BundleConfig.pb"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"

# 4: a debug certificate, whether or not a fingerprint is asked for — with none, then with the
# debug key's own fingerprint, which it would pass if the debug refusal were not checked first.
mint "CN=Android Debug,O=Android,C=US"
sentinel
if sign; then fail "signed with an Android debug certificate"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"
"$keytool" -exportcert -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" -file "$work/debug.der" > /dev/null 2>&1 \
  || fail "keytool could not export the debug certificate"
sha256sum "$work/debug.der" | cut -d' ' -f1 > "$pin"
sentinel
if ANDROID_SIGNER_PIN="$pin" sign; then fail "signed with an Android debug certificate its fingerprint names"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"

# 7: the same path for input and output is refused and the file is left exactly as it was — on a
# copy, never on the caller's bundle.
cp "$bundle" "$work/same.aab"
same=$(sha256sum "$work/same.aab" | cut -d' ' -f1)
if bash "$HERE/sign-bundle.sh" "$work/same.aab" "$work/same.aab" > /dev/null; then
  fail "signed a bundle over itself"
fi
[ -s "$work/same.aab" ] || fail "a refused signing deleted its input"
[ "$(sha256sum "$work/same.aab" | cut -d' ' -f1)" = "$same" ] || fail "a refused signing changed its input"

echo "android-sign proof: passed — one signing, five refusals (each clearing the output path, or sparing the input when it is the output), the input untouched"
