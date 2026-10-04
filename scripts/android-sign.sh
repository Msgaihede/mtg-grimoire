#!/usr/bin/env bash
# Sign the light app's APK with a keystore, and prove the result is signed by it — the release
# rule's Android half (light app phase 6, step 6.6).
#
#   ANDROID_KEYSTORE=<path> ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… \
#     [ANDROID_EXPECT_VERSION=0.41.0] [ANDROID_SIGNER_PIN=<file>] \
#     bash scripts/android-sign.sh <in.apk> <out.apk>
#
# Two jobs run it, with one difference between them:
#
#   - `release.yml`'s `android-sign`, with the release keystore decoded from a secret and
#     ANDROID_SIGNER_PIN naming the committed fingerprint every release is held to
#     (`mobile/src-tauri/release-signer.sha256`). What it writes is the APK a release attaches.
#   - `ci.yml`'s `android`, with a keystore `keytool` minted a second earlier and deletes a second
#     later. What it writes is thrown away: the run is the proof that this file works, on every
#     pull request that can have changed the APK, so the first release is not its first run. It
#     runs the refusals too — a fingerprint that is another key's, and a debug certificate.
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
# **And one it has no business signing.** A keystore whose certificate is the Android debug one
# is refused whatever else is true; and with ANDROID_SIGNER_PIN set, so is a keystore whose
# certificate is not the one that file names — before anything is signed. "Signed by the key it
# was handed" is not "signed by the key the last release was": a keystore made a second time
# passes the first and strands every phone.
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
aapt2="$tools/aapt2"
[ -x "$apksigner" ] || die "no apksigner in $tools"
[ -x "$zipalign" ] || die "no zipalign in $tools"
keytool=keytool
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then keytool="$JAVA_HOME/bin/keytool"; fi
command -v "$keytool" > /dev/null || die "no keytool on PATH or under JAVA_HOME"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# **Which tools, said before anything is asked of them.** The first run of this script against a
# real SDK refused an APK and printed nothing of what `apksigner` had said, which made the
# refusal undiagnosable from the run. So: the build-tools there are, the one chosen, each tool's
# own version, and — below — every tool's raw answer beside what was read out of it. Nothing
# here is secret: versions, certificate digests and an APK's manifest line are all public.
say() { echo "android-sign: $*" >&2; }
# `quote <file>`: a tool's own words, indented, on stderr.
quote() { sed 's/^/    | /' "$1" >&2; }
say "build-tools installed: $(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | tr '\n' ' ')— using $(basename "$tools")"
say "apksigner: $apksigner, version $("$apksigner" --version 2>&1 | head -1) (on PATH: $(command -v apksigner || echo none))"
say "java, which apksigner runs on: $(java -version 2>&1 | head -1) (JAVA_HOME=${JAVA_HOME:-unset})"
say "aapt2: $("$aapt2" version 2>&1 | head -1)"

# `verify_certs <apk> <name>`: asks `apksigner` who signed an APK, keeps its whole answer —
# stdout and stderr, in $work/<name>.txt — prints it, and returns its exit status. A verify
# that only warns exits 0, with the warnings among the lines.
verify_certs() {
  local status=0
  "$apksigner" verify --print-certs "$1" > "$work/$2.txt" 2>&1 || status=$?
  say "\`apksigner verify --print-certs $1\` exited $status and said:"
  quote "$work/$2.txt"
  return "$status"
}

# `digests <name>`: every signer's certificate SHA-256 in that answer, lower-case, each once.
#
# **Matched on what every form of the line shares** — `… certificate SHA-256 digest: <hex>` —
# because the part in front of it has three wordings, and the first run met the one this script
# did not know:
#
#   - `V2 Signer: certificate SHA-256 digest: …` and `V3.0 Signer: …` — **what build-tools
#     37.0.0 prints**, measured on the runner (2026-10-04): the scheme that verified, and a
#     colon. The build's own APK answered `V2 Signer:`, the re-signed one `V3.0 Signer:`.
#   - `Signer #1 certificate SHA-256 digest: …` — `ApkSignerTool.java` on AOSP's `main` as read
#     that day, and every older build-tools, for an APK verified by v1, v2 or v3.
#   - `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: …` — the
#     same source for a rotated key (v3.1), once per v3.1 signer and once per v3 one, with
#     ` (dev release=true)` inside the brackets for a rotation aimed at a development release.
#
# `Source Stamp Signer` is not a signer of the APK — it is a store's stamp — and is left out.
# A certificate named by two schemes is one certificate: each digest is counted once.
digests() {
  sed -n '/^Source Stamp Signer/d; s/^.* certificate SHA-256 digest: *\([0-9A-Fa-f]\{64\}\)[[:space:]]*$/\1/p' \
    "$work/$1.txt" | tr 'A-F' 'a-f' | sort -u
}

# The keystore's certificate, as bytes, hashed here — so the comparison below is between two
# tools' answers and not one tool's answer with itself.
# `keytool` says why it failed on stdout — a wrong password, an alias that is not there — so its
# first line is kept for the refusal. It never prints the password it was given.
"$keytool" -exportcert -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" -file "$work/cert.der" > "$work/keytool.txt" 2>&1 \
  || die "keytool could not read the key from the keystore: $(head -1 "$work/keytool.txt")"
[ -s "$work/cert.der" ] || die "keytool exported an empty certificate"
key=$(sha256sum "$work/cert.der" | cut -d' ' -f1)

# **Never the Android debug key**, whatever else is true of it: every SDK mints its own
# `CN=Android Debug`, so an APK signed with one updates over nothing but itself.
"$keytool" -printcert -file "$work/cert.der" > "$work/subject.txt" 2>&1 \
  || die "keytool could not read the certificate it exported"
if grep -qi 'CN=Android Debug' "$work/subject.txt"; then
  die "the keystore's certificate is an Android debug certificate (CN=Android Debug), which no release is signed with"
fi

# **The signer every release has had, or none.** Comparing the output with the keystore proves
# the signing worked, not that it is the *same* key as the last release's — a keystore made
# again, or the wrong one pasted into the secret, would pass, and its APK would not install over
# the one on anybody's phone. So a release names the certificate it expects in a committed file
# (ANDROID_SIGNER_PIN: one line, the SHA-256 as 64 lower-case hex), and a keystore that is not
# that one is refused before anything is signed. The digest is public — it is in every APK.
if [ -n "${ANDROID_SIGNER_PIN:-}" ]; then
  [ -f "$ANDROID_SIGNER_PIN" ] || die "no signer fingerprint at $ANDROID_SIGNER_PIN"
  pin=$(tr -d '\r\n' < "$ANDROID_SIGNER_PIN")
  [[ "$pin" =~ ^[0-9a-f]{64}$ ]] \
    || die "$ANDROID_SIGNER_PIN is not one line of 64 lower-case hex characters"
  [ "$pin" = "$key" ] \
    || die "the keystore's certificate is $key, and $ANDROID_SIGNER_PIN says every release is signed by $pin"
fi

# **Who signed the input is a note, not a condition.** The build signs it with a debug key, and
# this script would sign an unsigned APK just as well: nothing below depends on the answer. (It
# was a condition until the first real run, where it refused the runner's own build before
# signing anything.) What it is good for is the summary's "signer before", and for showing, in
# the same log, how this `apksigner` words an answer before the one that matters.
before="none read"
if verify_certs "$IN" in; then
  if [ -n "$(digests in)" ]; then before=$(digests in | paste -sd ' '); fi
else
  before="none: apksigner does not verify it"
fi
say "the input's signer: $before"

# `zipalign -c` answers with its exit status; its words are kept for a refusal.
# `aligned <apk> <name>`: stored entries on 4-byte boundaries and libraries on 4 KB pages.
# `aligned_16k`: libraries on 16 KB pages — a flag older build-tools do not know, which reads
# here as "no", and so never as a loss.
aligned() { "$zipalign" -c -v -p 4 "$1" > "$work/$2.4k.txt" 2>&1; }
aligned_16k() { "$zipalign" -c -v -P 16 4 "$1" > "$work/$2.16k.txt" 2>&1; }
in_aligned=no
in_aligned_16k=no
if aligned "$IN" in; then in_aligned=yes; fi
if aligned_16k "$IN" in; then in_aligned_16k=yes; fi

"$apksigner" sign \
  --ks "$ANDROID_KEYSTORE" \
  --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --key-pass env:ANDROID_KEY_PASSWORD \
  --out "$OUT" \
  "$IN" > "$work/sign.txt" 2>&1 || {
  say "\`apksigner sign\` failed and said:"
  quote "$work/sign.txt"
  die "apksigner could not sign $IN"
}
quote "$work/sign.txt"
[ -s "$OUT" ] || die "apksigner reported success and wrote no APK at $OUT"
# The v4 signature, a file beside the APK that only an incremental `adb install` reads.
rm -f "$OUT.idsig"

# **The condition: one signer, and the keystore's.** `verify_certs` has printed the tool's own
# words above whichever line refuses.
verify_certs "$OUT" out || die "apksigner does not verify the APK it just signed (its answer is above)"
after=$(digests out)
count=$(grep -c . <<< "$after" || true)
[ "$count" != 0 ] \
  || die "no signer's certificate could be read from apksigner's answer about the signed APK (above): it is worded in a way this script does not know"
# More than one distinct certificate is a rotated key (v3.1's lineage) or two signers, and
# neither is anything this script made: the keystore holds one key.
[ "$count" = 1 ] || die "the signed APK names $count different signer certificates, not one: $(paste -sd ' ' <<< "$after")"
[ "$after" = "$key" ] || die "the signed APK's certificate is $after, and the keystore's is $key"

out_aligned=no
out_aligned_16k=no
if aligned "$OUT" out; then out_aligned=yes; fi
if aligned_16k "$OUT" out; then out_aligned_16k=yes; fi
say "aligned, 4 KB / 16 KB: in $in_aligned / $in_aligned_16k, out $out_aligned / $out_aligned_16k"
# zipalign's last lines for a check that said no — on the input too, where "no" to the 16 KB
# question may only be a `zipalign` that does not know `-P`.
for check in in.4k in.16k out.4k out.16k; do
  if ! grep -q 'Verification succesful\|Verification successful' "$work/$check.txt"; then
    say "zipalign's answer for $check (last lines):"
    tail -4 "$work/$check.txt" > "$work/tail.txt"
    quote "$work/tail.txt"
  fi
done
if [ "$in_aligned" = yes ] && [ "$out_aligned" != yes ]; then
  die "re-signing lost the 4 KB alignment Gradle gave the APK"
fi
if [ "$in_aligned_16k" = yes ] && [ "$out_aligned_16k" != yes ]; then
  die "re-signing lost the 16 KB alignment Gradle gave the APK's libraries"
fi

# What Android compares when it decides whether this APK may replace an installed one: the
# `versionCode` must be higher. Tauri derives it from `tauri.conf.json`'s version — major ×
# 1,000,000 + minor × 1,000 + patch — and with ANDROID_EXPECT_VERSION set this holds the APK to
# that version and that arithmetic, read back out of the APK itself: `aapt2 dump badging`'s
# `package: name='…' versionCode='…' versionName='…' …` line, wherever in its answer it is.
badging_status=0
"$aapt2" dump badging "$OUT" > "$work/badging.txt" 2> "$work/badging.err" || badging_status=$?
badging=$(grep -m1 '^package:' "$work/badging.txt" || true)
version_code=$(sed -n "s/.*[[:space:]]versionCode='\([0-9]*\)'.*/\1/p" <<< "$badging")
version_name=$(sed -n "s/.*[[:space:]]versionName='\([^']*\)'.*/\1/p" <<< "$badging")
say "\`aapt2 dump badging\` exited $badging_status; its package line: ${badging:-(none)}"
if [ -z "$version_code" ] || [ -z "$version_name" ]; then
  say "no versionCode and versionName could be read from it. Its first lines, then its errors:"
  head -5 "$work/badging.txt" > "$work/head.txt"
  quote "$work/head.txt"
  quote "$work/badging.err"
fi
if [ -n "${ANDROID_EXPECT_VERSION:-}" ]; then
  [ -n "$version_code" ] || die "aapt2 could not read the APK's versionCode (its answer is above)"
  # A plain x.y.z or nothing: a pre-release (`0.41.0-rc.1`) has no place in Tauri's arithmetic,
  # and shell arithmetic on its pieces would compute something and call it a versionCode.
  [[ "$ANDROID_EXPECT_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
    || die "ANDROID_EXPECT_VERSION is '$ANDROID_EXPECT_VERSION', not a plain x.y.z, so no versionCode follows from it"
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
  echo "| signer before | \`$before\` |"
  echo "| aligned, 4 KB / 16 KB — in | $in_aligned / $in_aligned_16k |"
  echo "| aligned, 4 KB / 16 KB — out | $out_aligned / $out_aligned_16k |"
  echo "| build-tools | \`$(basename "$tools")\` |"
} >> "$SUMMARY"
echo "android-sign: $OUT is signed by $after"
