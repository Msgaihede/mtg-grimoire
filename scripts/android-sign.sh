#!/usr/bin/env bash
# Sign the light app's APK with a keystore, and prove the result is signed by it — the release
# rule's Android half (light app phase 6, step 6.6).
#
#   ANDROID_KEYSTORE=<path> ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… \
#     [ANDROID_EXPECT_VERSION=0.41.0] bash scripts/android-sign.sh <in.apk> <out.apk>
#
# Two jobs run it, with one difference between them:
#
#   - `release.yml`'s `android-sign`, with the release keystore decoded from a secret. What it
#     writes is the APK a release attaches.
#   - `ci.yml`'s `android`, with a keystore `keytool` minted a second earlier and deletes a second
#     later. What it writes is thrown away: the run is the proof that this file works, on every
#     pull request that can have changed the APK, so the first release is not its first run.
#
# **Why a re-sign, and not Gradle's own signing config.** Gradle signs inside the build, so the
# keystore and its passwords would sit on disk in a job that also runs every npm lifecycle
# script, every cargo build script and every Gradle plugin — any of which can read a file. This
# repository's rule for a release's signing secret is older than this file: *the secret goes in a
# job of its own, never a build leg* (docs/reference/ci-and-releases.md). So the build leg
# builds what `ci.yml` builds, signed with the runner's debug key, and this script — in a job
# that runs nothing but the Android SDK's own tools — replaces that signature. `apksigner sign`
# on a signed APK discards the old signing block and writes a new one; the contents are not
# touched.
#
# **It refuses to hand back an APK it cannot vouch for.** After signing it asks `apksigner` who
# signed the output and compares that certificate's SHA-256 with the keystore's own, taken
# another way (`keytool -exportcert` through `sha256sum`). One signer, and that one, or it exits
# non-zero and deletes the output — an APK signed with any other key cannot update over the last
# release's, and an update that will not install means an uninstall, which wipes `user.db` and a
# paired identity with it.
#
# **And it refuses to lose what Gradle aligned.** A library stored uncompressed has to sit on a
# page boundary or Android will not map it. If the input passes `zipalign -c -p 4`, the output
# must; the same for the 16 KB check, where this `zipalign` knows the flag.
#
# **And, asked to, it holds the APK to its version**: with ANDROID_EXPECT_VERSION set, the
# `versionName` inside the APK must be that version and the `versionCode` Tauri's arithmetic on
# it. Android installs an update only over a lower `versionCode`.
#
# The passwords are read from the environment by `apksigner` and `keytool` themselves
# (`env:NAME`, `-storepass:env NAME`), so neither is ever on a command line. The certificate's
# digest is printed: it is public, and is in every APK the key signs.
set -euo pipefail

IN=${1:?usage: android-sign.sh <in.apk> <out.apk>}
OUT=${2:?usage: android-sign.sh <in.apk> <out.apk>}
: "${ANDROID_KEYSTORE:?set ANDROID_KEYSTORE to the keystore file}"
: "${ANDROID_KEYSTORE_PASSWORD:?set ANDROID_KEYSTORE_PASSWORD}"
: "${ANDROID_KEY_ALIAS:?set ANDROID_KEY_ALIAS}"
: "${ANDROID_KEY_PASSWORD:?set ANDROID_KEY_PASSWORD}"
: "${ANDROID_HOME:?ANDROID_HOME is not set, so there is no Android SDK to take apksigner from}"
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/stdout}

die() {
  echo "android-sign: $*" >&2
  rm -f "$OUT" "$OUT.idsig"
  exit 1
}

[ -s "$IN" ] || die "no APK at $IN"
[ -s "$ANDROID_KEYSTORE" ] || die "no keystore at $ANDROID_KEYSTORE"
[ "$IN" != "$OUT" ] || die "the output would overwrite the input"

# The SDK's newest build-tools: the directory names are versions, and `sort -V` orders them.
[ -d "$ANDROID_HOME/build-tools" ] || die "no build-tools under $ANDROID_HOME"
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
[ -n "$tools" ] || die "no build-tools under $ANDROID_HOME"
apksigner="$tools/apksigner"
zipalign="$tools/zipalign"
[ -x "$apksigner" ] || die "no apksigner in $tools"
[ -x "$zipalign" ] || die "no zipalign in $tools"
keytool=keytool
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then keytool="$JAVA_HOME/bin/keytool"; fi
command -v "$keytool" > /dev/null || die "no keytool on PATH or under JAVA_HOME"

# Every signer's certificate digest, one to a line, lower-case hex.
signers() {
  "$apksigner" verify --print-certs "$1" \
    | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p' \
    | tr 'A-F' 'a-f'
}

# The keystore's certificate, as bytes, hashed here — so the comparison below is between two
# tools' answers and not one tool's answer with itself.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# `keytool` says why it failed on stdout — a wrong password, an alias that is not there — so its
# first line is kept for the refusal. It never prints the password it was given.
"$keytool" -exportcert -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" -file "$work/cert.der" > "$work/keytool.txt" 2>&1 \
  || die "keytool could not read the key from the keystore: $(head -1 "$work/keytool.txt")"
[ -s "$work/cert.der" ] || die "keytool exported an empty certificate"
key=$(sha256sum "$work/cert.der" | cut -d' ' -f1)

# The input must be an APK this parse can read a signer from. If `apksigner` ever words its
# answer differently, this is where it shows — before anything is signed, not as a false alarm
# after.
before=$(signers "$IN") || die "apksigner could not verify $IN"
[ -n "$before" ] || die "apksigner named no signer for $IN — is it signed at all?"

aligned() { "$zipalign" -c -p 4 "$1" > /dev/null 2>&1; }
aligned_16k() { "$zipalign" -c -P 16 4 "$1" > /dev/null 2>&1; }
in_aligned=no
in_aligned_16k=no
if aligned "$IN"; then in_aligned=yes; fi
if aligned_16k "$IN"; then in_aligned_16k=yes; fi

"$apksigner" sign \
  --ks "$ANDROID_KEYSTORE" \
  --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$OUT" \
  "$IN" || die "apksigner could not sign $IN"
# The v4 signature, a file beside the APK that only an incremental `adb install` reads.
rm -f "$OUT.idsig"

after=$(signers "$OUT") || die "apksigner could not verify the APK it just signed"
[ "$(grep -c . <<< "$after")" = 1 ] || die "the signed APK names $(grep -c . <<< "$after") signers, not one"
[ "$after" = "$key" ] || die "the signed APK's certificate is $after, and the keystore's is $key"

out_aligned=no
out_aligned_16k=no
if aligned "$OUT"; then out_aligned=yes; fi
if aligned_16k "$OUT"; then out_aligned_16k=yes; fi
if [ "$in_aligned" = yes ] && [ "$out_aligned" != yes ]; then
  die "re-signing lost the 4 KB alignment Gradle gave the APK"
fi
if [ "$in_aligned_16k" = yes ] && [ "$out_aligned_16k" != yes ]; then
  die "re-signing lost the 16 KB alignment Gradle gave the APK's libraries"
fi

# What Android compares when it decides whether this APK may replace an installed one: the
# `versionCode` must be higher. Tauri derives it from `tauri.conf.json`'s version — major ×
# 1,000,000 + minor × 1,000 + patch — and with ANDROID_EXPECT_VERSION set this holds the APK to
# that version and that arithmetic, read back out of the APK itself.
badging=$("$tools/aapt2" dump badging "$OUT" 2> /dev/null | head -1) || true
version_code=$(sed -n "s/.* versionCode='\([0-9]*\)'.*/\1/p" <<< "$badging")
version_name=$(sed -n "s/.* versionName='\([^']*\)'.*/\1/p" <<< "$badging")
if [ -n "${ANDROID_EXPECT_VERSION:-}" ]; then
  [ -n "$version_code" ] || die "aapt2 could not read the APK's versionCode"
  IFS=. read -r major minor patch <<< "$ANDROID_EXPECT_VERSION"
  want=$((major * 1000000 + minor * 1000 + patch))
  [ "$version_name" = "$ANDROID_EXPECT_VERSION" ] \
    || die "the APK's versionName is '$version_name', and the version is $ANDROID_EXPECT_VERSION"
  [ "$version_code" = "$want" ] \
    || die "the APK's versionCode is $version_code, and $ANDROID_EXPECT_VERSION makes $want"
fi

{
  echo "### Signed APK"
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| file | \`$(basename "$OUT")\`, $(stat -c %s "$OUT") bytes |"
  echo "| versionName / versionCode | ${version_name:-?} / ${version_code:-?} |"
  echo "| signer's certificate, SHA-256 | \`$after\` |"
  echo "| signer before (the build's debug key) | \`$(head -1 <<< "$before")\` |"
  echo "| aligned, 4 KB / 16 KB — in | $in_aligned / $in_aligned_16k |"
  echo "| aligned, 4 KB / 16 KB — out | $out_aligned / $out_aligned_16k |"
  echo "| build-tools | \`$(basename "$tools")\` |"
} >> "$SUMMARY"
echo "android-sign: $OUT is signed by $after"
