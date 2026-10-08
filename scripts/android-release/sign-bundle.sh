#!/usr/bin/env bash
# Sign the light app's Android App Bundle with the upload key, and prove the result is signed by
# it and by nothing else — the release rule's Android half, for Google Play.
#
#   ANDROID_KEYSTORE=<path> ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… \
#     [ANDROID_SIGNER_PIN=<file>] bash scripts/android-release/sign-bundle.sh <in.aab> <out.aab>
#
# Two callers, with one difference between them:
#
#   - `release.yml`'s `android-sign`, with the upload keystore decoded from a secret and
#     ANDROID_SIGNER_PIN naming the committed fingerprint every release is held to
#     (`apps/light/src-tauri/release-signer.sha256`). What it writes is the bundle the owner uploads
#     to Play Console.
#   - `proof.sh` beside this file, which `ci.yml`'s `android` job runs over the bundle it just
#     built, on keys minted and deleted in the run. What it writes is thrown away: the run is
#     the proof that this file works, refusals included, before a release is its first run.
#
# **Why a re-sign, and not Gradle's own signing config.** Gradle signs inside the build, so the
# keystore and its passwords would sit on disk in a job that also runs every npm lifecycle
# script, every cargo build script and every Gradle plugin. The rule here is older than this
# file: *a signing secret goes in a job of its own, never a build leg*
# (docs/reference/ci-and-releases.md). So the build leg builds what `ci.yml` builds, signed with
# the runner's debug key, and this script — which runs the JDK's own tools and nothing else —
# takes that signature off and puts the upload key's on.
#
# **Why the old signature is stripped first.** A bundle is signed as a JAR, and `jarsigner` adds
# a signer beside the ones already there: signing the build's output as it is leaves a bundle
# signed by the debug key *and* the upload key. `StripSignature.java` removes the JAR signature
# (`META-INF/MANIFEST.MF`, `*.SF`, `*.RSA`, `*.DSA`, `*.EC`) and touches no other entry; this
# script then holds the output to the same list of entries the input had.
#
# **The key is an upload key.** Google holds the key Play signs installs with (Play App
# Signing) and can reset a lost upload key, so this is not the unrecoverable secret an APK's
# signing key is. The fingerprint is still pinned: a keystore pasted into the settings by
# mistake should be refused here, by name, and not by Play Console after a release has run.
#
# **It refuses to hand back a bundle it cannot vouch for.** After signing it asks `jarsigner`
# whether the bundle verifies and `keytool` who signed it, and compares that certificate's
# SHA-256 with the keystore's own, taken another way (`keytool -exportcert` through
# `sha256sum`). One signer, and that one, or it exits non-zero and deletes the output.
#
# The passwords are read from the environment by `jarsigner` and `keytool` themselves
# (`-storepass:env NAME`), so neither is ever on a command line. Every tool's own answer is
# printed beside what was read out of it: a refusal that hides what the tool said cannot be
# diagnosed from a run. Nothing printed is secret — versions, entry names and a certificate's
# digest, which is in every bundle the key signs.
set -euo pipefail

IN=${1:?usage: sign-bundle.sh <in.aab> <out.aab>}
OUT=${2:?usage: sign-bundle.sh <in.aab> <out.aab>}
: "${ANDROID_KEYSTORE:?set ANDROID_KEYSTORE to the keystore file}"
: "${ANDROID_KEYSTORE_PASSWORD:?set ANDROID_KEYSTORE_PASSWORD}"
: "${ANDROID_KEY_ALIAS:?set ANDROID_KEY_ALIAS}"
: "${ANDROID_KEY_PASSWORD:?set ANDROID_KEY_PASSWORD}"
: "${JAVA_HOME:?JAVA_HOME is not set, so there is no JDK to take jarsigner from}"
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/stdout}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() {
  echo "::error title=android-sign::$*"
  echo "android-sign: $*" >&2
  rm -f "$OUT"
  exit 1
}
say() { echo "android-sign: $*" >&2; }
# `quote <file>`: a tool's own words, indented, on stderr.
quote() { sed 's/^/    | /' "$1" >&2; }

# First, and not through `die`: `die` removes $OUT, and when $OUT is the input that is the only
# copy of the bundle. The same file under two spellings (`-ef`) is the same file.
if [ "$IN" = "$OUT" ] || [ "$IN" -ef "$OUT" ]; then
  echo "::error title=android-sign::the output would overwrite the input"
  echo "android-sign: the output would overwrite the input" >&2
  exit 1
fi
[ -s "$IN" ] || die "no bundle at $IN"
[ -s "$ANDROID_KEYSTORE" ] || die "no keystore at $ANDROID_KEYSTORE"

# A JDK, not a runtime: `java StripSignature.java` compiles the file it is handed.
java="$JAVA_HOME/bin/java"
jar="$JAVA_HOME/bin/jar"
jarsigner="$JAVA_HOME/bin/jarsigner"
keytool="$JAVA_HOME/bin/keytool"
for tool in "$java" "$jar" "$jarsigner" "$keytool"; do
  [ -x "$tool" ] || die "no $(basename "$tool") under JAVA_HOME ($JAVA_HOME): it must be a JDK"
done
say "java: $("$java" -version 2>&1 | head -1) (JAVA_HOME=$JAVA_HOME)"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# `entries <archive> <name>`: every entry that is not part of a JAR signature, sorted, in
# $work/<name>.entries. The JAR signature is what this script replaces; the rest it must not touch.
entries() {
  "$jar" tf "$1" > "$work/$2.all" 2> "$work/$2.err" || {
    quote "$work/$2.err"
    return 1
  }
  tr -d '\r' < "$work/$2.all" \
    | grep -Evi '^META-INF/(MANIFEST\.MF|[^/]*\.(SF|RSA|DSA|EC)|SIG-[^/]*)$' \
    | grep -v '^META-INF/$' \
    | sort > "$work/$2.entries"
}

# **A bundle, and not an APK handed over by mistake.** Both are archives `jarsigner` would sign.
# `BundleConfig.pb` at the root is what makes an archive a bundle (bundletool writes it; an APK
# has none), and Play Console would refuse the other after the release had run.
entries "$IN" in || die "$IN is not an archive the JDK can read (its answer is above)"
grep -qx 'BundleConfig.pb' "$work/in.entries" \
  || die "$IN holds no BundleConfig.pb, so it is not an Android App Bundle"

# The keystore's certificate, as bytes, hashed here — so the comparison below is between two
# tools' answers and not one tool's answer with itself. `keytool` says why it failed on stdout
# (a wrong password, an alias that is not there) and never prints the password it was given.
"$keytool" -exportcert -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" -file "$work/cert.der" > "$work/keytool.txt" 2>&1 \
  || die "keytool could not read the key from the keystore: $(head -1 "$work/keytool.txt")"
[ -s "$work/cert.der" ] || die "keytool exported an empty certificate"
key=$(sha256sum "$work/cert.der" | cut -d' ' -f1)

# **Never the Android debug key**, whatever else is true of it: every SDK mints its own
# `CN=Android Debug`, and Play refuses a bundle signed with one.
"$keytool" -printcert -file "$work/cert.der" > "$work/subject.txt" 2>&1 \
  || die "keytool could not read the certificate it exported"
if grep -qi 'CN=Android Debug' "$work/subject.txt"; then
  die "the keystore's certificate is an Android debug certificate (CN=Android Debug), which no release is signed with"
fi

# **The upload key Play Console knows, or none.** ANDROID_SIGNER_PIN names a committed file: one
# line, the certificate's SHA-256 as 64 lower-case hex. A keystore that is not that one is
# refused before anything is signed.
if [ -n "${ANDROID_SIGNER_PIN:-}" ]; then
  [ -f "$ANDROID_SIGNER_PIN" ] || die "no signer fingerprint at $ANDROID_SIGNER_PIN"
  pin=$(tr -d '\r\n' < "$ANDROID_SIGNER_PIN")
  [[ "$pin" =~ ^[0-9a-f]{64}$ ]] \
    || die "$ANDROID_SIGNER_PIN is not one line of 64 lower-case hex characters"
  [ "$pin" = "$key" ] \
    || die "the keystore's certificate is $key, and $ANDROID_SIGNER_PIN says every release is signed by $pin"
fi

# The build's signature comes off a copy: the input is never written to.
cp "$IN" "$work/stripped.aab"
"$java" "$HERE/StripSignature.java" "$work/stripped.aab" > "$work/strip.txt" 2>&1 || {
  say "\`java StripSignature.java\` failed and said:"
  quote "$work/strip.txt"
  die "the build's signature could not be removed from a copy of $IN"
}
quote "$work/strip.txt"

"$jarsigner" \
  -keystore "$ANDROID_KEYSTORE" \
  -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -keypass:env ANDROID_KEY_PASSWORD \
  -sigalg SHA256withRSA -digestalg SHA-256 \
  -signedjar "$OUT" \
  "$work/stripped.aab" "$ANDROID_KEY_ALIAS" > "$work/sign.txt" 2>&1 || {
  say "\`jarsigner\` failed and said:"
  quote "$work/sign.txt"
  die "jarsigner could not sign $IN"
}
quote "$work/sign.txt"
[ -s "$OUT" ] || die "jarsigner reported success and wrote no bundle at $OUT"

# **The condition: it verifies, it has one signer, and that signer is the keystore's.**
# `jarsigner -verify` exits 0 for a jar it only warns about — a self-signed certificate is a
# warning, and every Android key is self-signed — so the words are what is read.
verify_status=0
"$jarsigner" -verify "$OUT" > "$work/verify.txt" 2>&1 || verify_status=$?
say "\`jarsigner -verify\` exited $verify_status and said:"
quote "$work/verify.txt"
grep -q '^jar verified\.' "$work/verify.txt" \
  || die "jarsigner does not verify the bundle it just signed (its answer is above)"

# `keytool -printcert -jarfile` prints each signer's certificate with a line
# `SHA256: AB:CD:…` — 32 bytes, so 95 characters with their colons. Measured on JDK 21 and 25.
certs_status=0
"$keytool" -printcert -jarfile "$OUT" > "$work/certs.txt" 2>&1 || certs_status=$?
say "\`keytool -printcert -jarfile\` exited $certs_status and said, of each signer:"
grep -E '^Signer #|^Owner:|SHA256:' "$work/certs.txt" > "$work/certs.short" || true
quote "$work/certs.short"
[ "$certs_status" = 0 ] || {
  quote "$work/certs.txt"
  die "keytool could not read who signed the bundle (its answer is above)"
}
after=$(sed -n 's/^[[:space:]]*SHA256: *\([0-9A-Fa-f:]\{95\}\)[[:space:]]*$/\1/p' "$work/certs.txt" \
  | tr -d ':\r' | tr 'A-F' 'a-f' | sort -u)
count=$(grep -c . <<< "$after" || true)
[ "$count" != 0 ] \
  || die "no signer's certificate could be read from keytool's answer about the signed bundle (above): it is worded in a way this script does not know"
[ "$count" = 1 ] \
  || die "the signed bundle names $count different signer certificates, not one: $(paste -sd ' ' <<< "$after")"
[ "$after" = "$key" ] || die "the signed bundle's certificate is $after, and the keystore's is $key"

# **And nothing but the signature moved**: the same entries in as out.
entries "$OUT" out || die "the signed bundle is not an archive the JDK can read (its answer is above)"
if ! diff "$work/in.entries" "$work/out.entries" > "$work/entries.diff"; then
  say "entries that differ between the input (<) and the signed bundle (>):"
  quote "$work/entries.diff"
  die "signing changed which entries the bundle holds"
fi

{
  echo "### Signed bundle"
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| file | \`$(basename "$OUT")\`, $(wc -c < "$OUT" | tr -d ' ') bytes |"
  echo "| entries | $(grep -c . "$work/out.entries") besides the signature |"
  echo "| signer's certificate, SHA-256 | \`$after\` |"
} >> "$SUMMARY"
echo "android-sign: $OUT is signed by $after"
