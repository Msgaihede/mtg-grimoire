# Google Play A — the release builds and signs a bundle: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A release run builds the light app as an Android App Bundle, signs it with the owner's upload key in a job that builds nothing, and leaves it as an artifact he uploads to Play Console — and nothing Android is attached to the GitHub release.

**Architecture:** The build legs (`ci.yml`'s `android`, `release.yml`'s `android`) run one identical Tauri command that makes the APK and the bundle, and hold the build to its version. Three small files under `scripts/android-release/` do the signing with JDK tools only: strip the build's debug signature from a copy, sign with `jarsigner`, and refuse any result that is not signed by exactly the pinned key. `ci.yml` proves that on throwaway keys in every pull request; `release.yml`'s `android-sign` runs it with the real key from the `release` environment.

**Tech Stack:** GitHub Actions, bash, JDK 21 (`jarsigner`, `keytool`, `jar`, single-file `java`), Tauri CLI 2 (`tauri android build`), Vitest text fences (`*.test.mjs`, `host.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-07-google-play-release-design.md` §4 (and §2, §7 for the decisions and the owner's runbook). Read it before starting.

## Global Constraints

- **Play only.** No APK and no bundle is uploaded to a GitHub release. `android-sign` holds `contents: read`.
- **A signing secret never sits in a build leg.** `android-sign` runs no `npm`, no cargo, no Gradle: a checkout, an artifact download, one `bash scripts/android-release/sign-bundle.sh …`, an artifact upload. `scripts/release-rule.test.mjs` lists every command it may run, to the letter.
- **The Gradle project learns no key.** `gen/android/app/build.gradle.kts` keeps `signingConfig = signingConfigs.getByName("debug")`. No `keystore.properties`, no `signingConfigs { }` block.
- **Secret names and alias are unchanged:** `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`; alias `mtg-grimoire`; pin `mobile/src-tauri/release-signer.sha256` (one line, 64 lower-case hex).
- **arm64 only:** `--target aarch64`.
- **Artifact names:** the build's `android-aab-debug-signed` (14 days); the signed `play-upload-bundle` (30 days), file `mtg-grimoire-<version>-android.aab`.
- **Every third-party action stays pinned by SHA** with its tag in a comment; every checkout keeps `persist-credentials: false` (`scripts/actions-pinned.test.mjs`).
- **In any non-comment line of `android-sign`, never write** the word `secrets` except as `${{ secrets.NAME }}`, and never the bare words `npx npm pnpm yarn bun deno node cargo rustc gradle python pip curl wget bash sh pwsh docker gh make` outside the one listed command — the fence reads them as commands. Comment lines (`#`) are exempt.
- **No agent makes a key, sets a secret, or changes a repository setting.** Those are the owner's (spec §7).
- **One commit for this whole plan** (`feat(android): …`), made in the last task. No intermediate commits: release-please writes the changelog from commits.
- **`npm run verify` runs once, in the last task.** Before that, run only the single test file a step names.
- **New files are LF.** `.gitattributes` says `* text=auto eol=lf`; write with the Write tool, never a Python text write.
- **This worktree needs `npm install` before any Vitest run** (the `worktree-setup` skill).

## Deviation from the spec

Spec §4 says `release.yml` runs `tauri android build --aab`. This plan runs **`--apk --aab` in both workflows**, because `release-rule.test.mjs` holds a release's build command equal to the one every pull request ran ("a command that differs is one no pull request has run"), and `ci.yml` still needs the APK for its size report and its installable artifact. The release's APK is built and left in its job; nothing uploads it.

## Review Focus

1. **A bundle that arrives already signed** (Gradle signs it with the debug key) must come out with exactly one signer, the upload key. A reviewer would expect "signed by A and B" to be refused. → `proof.sh` signs an input that already carries a debug-shaped signature (Task 1).
2. **An APK, or any archive that is not a bundle, handed to the signer** must be refused before signing, not by Play Console after the release. → `proof.sh` case 5 (Task 1).
3. **A keystore that is not the pinned one, or a debug certificate**, must be refused and leave no output file. → `proof.sh` cases 3 and 4 (Task 1).
4. **A build whose version is not the tag's** (a stale `tauri.properties`, a pre-release string) must fail the build leg. → Task 1, Step 6.
5. **Some of the three key values set and not all, or the key set with no committed pin**, must fail or skip exactly as today. → the unchanged `asks whether its secrets are set` and pin fences (Task 2).

Not covered by any test, and worth a reviewer's eye: a re-run of `android-sign` more than 14 days after its release finds no `android-aab-debug-signed` artifact and fails at the download — which is the right answer, and is only written down in Task 4's docs.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `scripts/android-release/sign-bundle.sh` | create | Sign one bundle with one keystore; refuse anything it cannot vouch for |
| `scripts/android-release/StripSignature.java` | create | Remove a JAR signature from an archive in place; touch nothing else |
| `scripts/android-release/proof.sh` | create | Exercise `sign-bundle.sh` on throwaway keys: one signing, three refusals |
| `scripts/android-release/check-version.sh` | create | Hold a build's `tauri.properties` to a version and Tauri's `versionCode` |
| `scripts/android-sign.sh` | delete | The APK signer, which existed for the GitHub APK |
| `.github/workflows/ci.yml` | modify | `android` job: build both, check the version, run the proof |
| `.github/workflows/release.yml` | modify | `android`: hand on the bundle; `android-sign`: sign it, upload an artifact |
| `scripts/ci-route.mjs` | modify | Route `scripts/android-release/*` to `frontend`, `rust`, `android` |
| `scripts/release-rule.test.mjs`, `scripts/ci-route.test.mjs`, `mobile/host.test.ts` | modify | The fences, rewritten for the bundle |
| `.gitignore` | modify | Ignore `*.aab` |
| `.github/CLAUDE.md`, `mobile/CLAUDE.md`, `CLAUDE.md`, `docs/reference/ci-and-releases.md` | modify | Say what is now true |

---

### Task 1: The Android release's scripts

**Files:**
- Create: `scripts/android-release/StripSignature.java`
- Create: `scripts/android-release/sign-bundle.sh`
- Create: `scripts/android-release/proof.sh`
- Create: `scripts/android-release/check-version.sh`
- Delete: `scripts/android-sign.sh`
- Modify: `.gitignore` (the Android signing block, after `*.keystore.b64`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bash scripts/android-release/sign-bundle.sh <in.aab> <out.aab>` — env `ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `JAVA_HOME` (a JDK), optional `ANDROID_SIGNER_PIN`, optional `GITHUB_STEP_SUMMARY`. Exit 0 with `<out.aab>` written, or non-zero with it absent.
  - `bash scripts/android-release/proof.sh <bundle.aab>` or `--fake` — env `JAVA_HOME`. Exit 0 and a last line starting `android-sign proof: passed`.
  - `bash scripts/android-release/check-version.sh <x.y.z> [<tauri.properties>]` — exit 0 and `android-version: versionName …, versionCode …`.

These four files were run in this plan's own drafting, on JDK 25 under Git Bash, against a fake bundle: the proof passed (one signing, three refusals, input untouched), and a bundle signed twice without the strip was confirmed to carry two signature blocks. CI's `android` job is the first run on JDK 21 against a real bundle.

- [ ] **Step 1: Write `scripts/android-release/StripSignature.java`**

```java
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Removes a JAR signature from an archive, in place: `META-INF/MANIFEST.MF` and every
 * `META-INF/*.SF`, `*.RSA`, `*.DSA`, `*.EC` and `SIG-*`. Every other entry is left as it is.
 *
 *   java StripSignature.java <archive>
 */
public class StripSignature {
    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: java StripSignature.java <archive>");
            System.exit(2);
        }
        List<String> removed = new ArrayList<>();
        try (FileSystem zip = FileSystems.newFileSystem(Path.of(args[0]))) {
            Path meta = zip.getPath("META-INF");
            if (Files.isDirectory(meta)) {
                List<Path> doomed = new ArrayList<>();
                try (var entries = Files.newDirectoryStream(meta)) {
                    for (Path entry : entries) {
                        if (Files.isRegularFile(entry) && isSignature(entry.getFileName().toString())) {
                            doomed.add(entry);
                        }
                    }
                }
                for (Path entry : doomed) {
                    Files.delete(entry);
                    removed.add(entry.toString());
                }
            }
        }
        System.out.println("removed " + removed.size() + " signature entries: " + String.join(" ", removed));
    }

    private static boolean isSignature(String file) {
        String name = file.toUpperCase(Locale.ROOT);
        return name.equals("MANIFEST.MF")
                || name.startsWith("SIG-")
                || name.endsWith(".SF")
                || name.endsWith(".RSA")
                || name.endsWith(".DSA")
                || name.endsWith(".EC");
    }
}
```

- [ ] **Step 2: Write `scripts/android-release/sign-bundle.sh`**

```bash
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
#     (`mobile/src-tauri/release-signer.sha256`). What it writes is the bundle the owner uploads
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
  echo "android-sign: $*" >&2
  rm -f "$OUT"
  exit 1
}
say() { echo "android-sign: $*" >&2; }
# `quote <file>`: a tool's own words, indented, on stderr.
quote() { sed 's/^/    | /' "$1" >&2; }

[ -s "$IN" ] || die "no bundle at $IN"
[ -s "$ANDROID_KEYSTORE" ] || die "no keystore at $ANDROID_KEYSTORE"
[ "$IN" != "$OUT" ] || die "the output would overwrite the input"

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
```

- [ ] **Step 3: Write `scripts/android-release/proof.sh`**

```bash
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
#   4. an Android debug certificate is refused, fingerprint or none, and no bundle is left behind;
#   5. an archive that is not a bundle is refused, and no bundle is left behind;
#   6. a bundle that reaches it already signed comes out with one signer — `--fake`'s input is
#      signed first with a debug-shaped key, as Gradle signs the build's.
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
    "$jarsigner" -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
      -keypass:env ANDROID_KEY_PASSWORD -signedjar "$work/fake.aab" \
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
sign() { bash "$HERE/sign-bundle.sh" "${1:-$bundle}" "$out"; }
before=$(sha256sum "$bundle" | cut -d' ' -f1)

# 1, 2 and 6: signed, held to the key's own fingerprint; the input as it was.
mint "CN=throwaway"
"$keytool" -exportcert -keystore "$ANDROID_KEYSTORE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" -file "$work/throwaway.der" > /dev/null 2>&1
sha256sum "$work/throwaway.der" | cut -d' ' -f1 > "$pin"
ANDROID_SIGNER_PIN="$pin" sign || fail "a bundle signed with the key its fingerprint names was refused"
[ -s "$out" ] || fail "the signing reported success and wrote no bundle"
[ "$(sha256sum "$bundle" | cut -d' ' -f1)" = "$before" ] || fail "the signing wrote to its input"
rm -f "$out"

# 3: another key's fingerprint.
printf '%064d\n' 0 > "$pin"
if ANDROID_SIGNER_PIN="$pin" sign; then fail "signed with a key the fingerprint does not name"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"

# 5: an archive that is not a bundle. Before the debug key is minted, so this is refused for
# what it is and not for who would sign it.
mkdir -p "$work/apk"
echo "not a bundle" > "$work/apk/classes.dex"
"$jar" cfM "$work/not-a-bundle.aab" -C "$work/apk" .
if sign "$work/not-a-bundle.aab"; then fail "signed an archive with no BundleConfig.pb"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"

# 4: a debug certificate, whether or not a fingerprint is asked for.
mint "CN=Android Debug,O=Android,C=US"
if sign; then fail "signed with an Android debug certificate"; fi
[ ! -e "$out" ] || fail "a refused signing left a bundle behind"

echo "android-sign proof: passed — one signing, three refusals, the input untouched"
```

- [ ] **Step 4: Write `scripts/android-release/check-version.sh`**

```bash
#!/usr/bin/env bash
# Hold an Android build to the version it is meant to carry — before anything is signed.
#
#   bash scripts/android-release/check-version.sh <x.y.z> [<tauri.properties>]
#
# Android installs an update only over a lower `versionCode`, and Play refuses an upload whose
# code it has seen. Tauri derives the code from `tauri.conf.json`'s version — major × 1,000,000 +
# minor × 1,000 + patch — and writes it, with the `versionName`, to the generated
# `tauri.properties` that `gen/android/app/build.gradle.kts` reads. This reads that file back
# after a build and refuses one whose name is not the version or whose code is not that
# arithmetic: a release whose bundle says another version is one Play Console would refuse after
# the release had run.
#
# **The properties file and not the bundle**, because a bundle's manifest is a protocol buffer
# that only `bundletool` reads, and neither build leg has it. The file is what Gradle was handed
# for this build; `scripts/release-rule.test.mjs` holds the Gradle project to reading it.
set -euo pipefail

VERSION=${1:?usage: check-version.sh <x.y.z> [<tauri.properties>]}
PROPS=${2:-mobile/src-tauri/gen/android/app/tauri.properties}

die() {
  echo "android-version: $*" >&2
  exit 1
}

# A plain x.y.z or nothing: a pre-release (`0.41.0-rc.1`) has no place in Tauri's arithmetic, and
# shell arithmetic on its pieces would compute something and call it a versionCode.
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "'$VERSION' is not a plain x.y.z, so no versionCode follows from it"
[ -s "$PROPS" ] || die "no $PROPS: the build that writes it has not run"

# `key=value`, with or without spaces round the sign, and a carriage return if a Windows build
# wrote it.
read_key() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$PROPS" | tr -d '\r' | head -1
}
name=$(read_key 'tauri\.android\.versionName')
code=$(read_key 'tauri\.android\.versionCode')
[ -n "$name" ] || die "$PROPS names no tauri.android.versionName"
[ -n "$code" ] || die "$PROPS names no tauri.android.versionCode"

IFS=. read -r major minor patch <<< "$VERSION"
want=$((major * 1000000 + minor * 1000 + patch))
[ "$name" = "$VERSION" ] || die "the build's versionName is '$name', and the version is $VERSION"
[ "$code" = "$want" ] || die "the build's versionCode is $code, and $VERSION makes $want"

echo "android-version: versionName $name, versionCode $code"
```

- [ ] **Step 5: Run the proof against a fake bundle**

`JAVA_HOME` must be a JDK, not a runtime (on the owner's machine `java` on `PATH` is a JRE and `JAVA_HOME` is JDK 25, which is right).

Run: `bash scripts/android-release/proof.sh --fake`

Expected: four `android-sign: …` refusal or success blocks, then the last line

```
android-sign proof: passed — one signing, three refusals, the input untouched
```

and exit status 0. In the first block, `removed 3 signature entries: META-INF/THROWAWA.RSA META-INF/THROWAWA.SF META-INF/MANIFEST.MF` shows the pre-existing signature came off, and exactly one `Signer #1:` line follows.

If it fails with `Module jdk.compiler not in boot Layer`, `JAVA_HOME` points at a JRE: point it at a JDK and run again.

- [ ] **Step 6: Run the version check through its refusals**

```bash
tmp=$(mktemp -d)
printf '// AUTOGENERATED\ntauri.android.versionName=0.42.0\r\ntauri.android.versionCode=42000\n' > "$tmp/ok.properties"
printf 'tauri.android.versionName=0.42.0\ntauri.android.versionCode=41000\n' > "$tmp/stale.properties"
bash scripts/android-release/check-version.sh 0.42.0 "$tmp/ok.properties"; echo "exit $?"
bash scripts/android-release/check-version.sh 0.42.0 "$tmp/stale.properties"; echo "exit $?"
bash scripts/android-release/check-version.sh 0.43.0 "$tmp/ok.properties"; echo "exit $?"
bash scripts/android-release/check-version.sh 0.42.0-rc.1 "$tmp/ok.properties"; echo "exit $?"
bash scripts/android-release/check-version.sh 0.42.0 "$tmp/missing.properties"; echo "exit $?"
rm -rf "$tmp"
```

Expected, in order:

```
android-version: versionName 0.42.0, versionCode 42000
exit 0
android-version: the build's versionCode is 41000, and 0.42.0 makes 42000
exit 1
android-version: the build's versionName is '0.42.0', and the version is 0.43.0
exit 1
android-version: '0.42.0-rc.1' is not a plain x.y.z, so no versionCode follows from it
exit 1
android-version: no …/missing.properties: the build that writes it has not run
exit 1
```

- [ ] **Step 7: Delete the APK signer, make the new scripts executable, ignore bundles**

```bash
git rm scripts/android-sign.sh
git add scripts/android-release
git update-index --chmod=+x scripts/android-release/sign-bundle.sh scripts/android-release/proof.sh scripts/android-release/check-version.sh
```

In `.gitignore`, in the block that begins `# An Android signing key, in every form`, add one line after `*.keystore.b64`:

```gitignore
*.aab
```

and append to that block's comment the sentence: `And a signed bundle, should the owner download one into this folder on its way to Play Console.`

---

### Task 2: The fences, rewritten for a bundle (they fail until Task 3)

**Files:**
- Modify: `scripts/release-rule.test.mjs`
- Modify: `scripts/ci-route.test.mjs`
- Modify: `mobile/host.test.ts`

**Interfaces:**
- Consumes: the three script paths from Task 1.
- Produces: the exact strings Task 3's workflows must contain.

- [ ] **Step 1: `scripts/release-rule.test.mjs` — imports and the secrets table**

After `import syncPull from "./web-sync-pull.mjs?raw";` add:

```js
import signProof from "./android-release/proof.sh?raw";
```

In `MAY_READ`, replace the `android-sign` row — the job no longer uploads to the release, so it reads no token:

```js
  "android-sign": [...ANDROID_SECRETS],
```

Replace the comment above `SIGNER_PIN`:

```js
/** The committed fingerprint of the upload certificate every release's bundle is signed with. */
```

- [ ] **Step 2: `scripts/release-rule.test.mjs` — what `android-sign` may run**

In the `it.each([...])("%s builds nothing, and runs only what is listed here", …)` table, replace the whole `android-sign` entry with:

```js
    [
      "android-sign",
      ["actions/checkout", "actions/download-artifact", "actions/upload-artifact"],
      ['bash scripts/android-release/sign-bundle.sh aab-in/mtg-grimoire-light-arm64.aab "$aab"'],
    ],
```

- [ ] **Step 3: `scripts/release-rule.test.mjs` — the pin test's name**

Rename `it("attaches no APK without the committed fingerprint, and holds the key to it", …)` to:

```js
  it("signs no bundle without the committed fingerprint, and holds the key to it", () => {
```

Its body is unchanged.

- [ ] **Step 4: `scripts/release-rule.test.mjs` — replace the "attaches the APK" test**

Replace the whole `it("attaches the APK the signing script wrote, under the release's name", …)` test with:

```js
  it("hands the signed bundle to the owner as an artifact, and puts nothing on the release", () => {
    const sign = jobs["android-sign"];
    expect(sign).toContain('aab="mtg-grimoire-$VERSION-android.aab"');
    expect(sign).toMatch(
      /bash scripts\/android-release\/sign-bundle\.sh aab-in\/mtg-grimoire-light-arm64\.aab "\$aab"/,
    );
    // The keystore is decoded outside the checkout and removed however the step ends.
    expect(sign).toContain('export ANDROID_KEYSTORE="$RUNNER_TEMP/release.keystore"');
    expect(sign).toContain(`trap 'rm -f "$ANDROID_KEYSTORE"' EXIT`);
    // What it signs is what `android` built…
    expect(jobs.android).toContain("name: android-aab-debug-signed");
    expect(sign).toContain("name: android-aab-debug-signed");
    // …and what it signed leaves as an artifact, which the owner uploads to Play Console.
    const upload = stepsOf(sign).at(-1);
    expect(upload).toMatch(/^uses: actions\/upload-artifact@/);
    expect(upload).toContain("name: play-upload-bundle");
    expect(upload).toContain("path: ${{ env.SIGNED_AAB }}");
    expect(upload).toContain("if-no-files-found: error");
    // **Play is the only place an Android build is published.** Neither job touches the
    // release, and the job that holds the key can write nothing to the repository.
    expect(jobs.android).not.toMatch(/gh release/);
    expect(sign).not.toMatch(/gh release|GITHUB_TOKEN|GH_TOKEN/);
    expect(sign).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(sign).not.toMatch(/contents: write/);
    // The build also makes a debug-signed APK, as every pull request's does. No job names one.
    expect(code(releaseYml)).not.toMatch(/\.apk\b/);
  });
```

- [ ] **Step 5: `scripts/release-rule.test.mjs` — the build commands and the proof**

In `it("builds the APK and the web app as `ci.yml` does", …)`, rename it and replace its first list and its last assertion:

```js
  it("builds the Android app and the web app as `ci.yml` does", () => {
    // The two build legs are copies of jobs that run green on every pull request; a command
    // that differs is one no pull request has run.
    for (const command of [
      "npx tauri android build --apk --aab --target aarch64 --ci",
      'bash scripts/android-release/check-version.sh "$VERSION"',
      "key: android-aarch64",
    ]) {
      expect(jobs.android, command).toContain(command);
      expect(ciYml, command).toContain(command);
    }
```

(the web list in the middle is unchanged) and replace the final two lines of the test:

```js
    // And the signing a release runs is the signing a pull request proved: `ci.yml` runs the
    // proof over its own bundle, and the proof runs the script `android-sign` runs.
    expect(ciYml).toMatch(/^\s+run: bash scripts\/android-release\/proof\.sh /m);
    expect(signProof).toContain('bash "$HERE/sign-bundle.sh"');
  });
```

- [ ] **Step 6: `scripts/release-rule.test.mjs` — who names an Android key**

In `it("names neither of the other two Workers, and no Cloudflare secret anywhere else", …)`, `ci.yml` no longer names the Android variables (the proof script mints its own). Replace from `const cloudflare =` to the end of the test:

```js
    const held = lines.filter(({ line }) => /CLOUDFLARE_|ANDROID_KEY/.test(line));
    // The throwaway key `ci.yml` proves the signing on is minted inside
    // `scripts/android-release/proof.sh`, so no workflow but the release names either.
    expect([...new Set(held.map(({ path }) => path))].sort()).toEqual([
      "/.github/workflows/release.yml",
    ]);
    expect(secretsOf(code(ciYml))).toEqual([]);
  });
```

- [ ] **Step 7: `scripts/ci-route.test.mjs`**

In the routing table, replace the row `["scripts/android-sign.sh", T, T, F, F, F, T, F],` and the comment above it with:

```js
    // The Android release's scripts, which `android` proves on throwaway keys and
    // `mobile/host.test.ts` reads as text; and the two deploy scripts no job in this gate runs.
    ["scripts/android-release/sign-bundle.sh", T, T, F, F, F, T, F],
    ["scripts/android-release/proof.sh", T, T, F, F, F, T, F],
    ["scripts/android-release/check-version.sh", T, T, F, F, F, T, F],
    ["scripts/android-release/StripSignature.java", T, T, F, F, F, T, F],
```

Replace the whole `it("puts the signing script above `scripts/*`, and `android` runs it", …)` test with:

```js
  it("puts the Android release's scripts above `scripts/*`, and `android` runs them", () => {
    const at = (pattern) => ARMS.findIndex((arm) => arm.match.includes(pattern));
    expect(at("scripts/android-release/*")).toBeGreaterThan(-1);
    expect(at("scripts/android-release/*")).toBeLessThan(at("scripts/*"));
    expect(ARMS[at("scripts/*")].jobs).not.toContain("android");
    const android = ciYml.slice(ciYml.indexOf("\n  android:"), ciYml.indexOf("\n  web:"));
    expect(android).toMatch(/^\s+bash scripts\/android-release\/check-version\.sh /m);
    expect(android).toMatch(/^\s+run: bash scripts\/android-release\/proof\.sh /m);
  });
```

- [ ] **Step 8: `mobile/host.test.ts`**

Replace the import on line 6:

```ts
import signScript from "../scripts/android-release/sign-bundle.sh?raw";
```

In `it("signs a release build with the debug key, and knows no other", …)` replace the comment's first two sentences with:

```ts
    // The upload key is `release.yml`'s `android-sign` job's, which re-signs the bundle this
    // project built (`scripts/android-release/sign-bundle.sh`) and runs no build. A signing
    // config here would put the keystore and its passwords on disk beside every npm script,
    // cargo build script and Gradle plugin a build runs.
```

In `it("names the release's signer in one line of hex, once the owner has made the key", …)` replace the comment with:

```ts
    // `src-tauri/release-signer.sha256` is the SHA-256 of the upload certificate every release's
    // bundle is signed with — public, and what Play Console shows as the upload key. `release.yml`
    // signs no bundle until it is committed, and `scripts/android-release/sign-bundle.sh` refuses
    // a keystore that is not the one it names. **Absent until the key exists**, so this holds
    // its shape for the day it appears — the script reads it with the same rule, and a file it
    // cannot read is a release with no bundle to upload.
```

The assertions under both comments are unchanged.

- [ ] **Step 9: Run the three fences and see them fail on the workflows**

Run: `npx vitest run scripts/release-rule.test.mjs scripts/ci-route.test.mjs mobile/host.test.ts`

Expected: FAIL. `host.test.ts` passes (its script exists). `release-rule.test.mjs` fails in the `android-sign` tests (the workflow still names `android-sign.sh` and `gh release upload`) and `ci-route.test.mjs` fails on `scripts/android-release/*` having no arm. If a test fails for another reason, stop and read it before going on.

---

### Task 3: The workflows and the router

**Files:**
- Modify: `scripts/ci-route.mjs` (the `scripts/android-sign.sh` arm)
- Modify: `.github/workflows/ci.yml` (job `android`: from `- name: Build the APK` to its `upload-artifact`; and the job's header comment)
- Modify: `.github/workflows/release.yml` (job `android` from `- name: Build the APK` to its end; job `android-sign` whole)

**Interfaces:**
- Consumes: Task 1's three commands; Task 2's exact strings.
- Produces: artifact `play-upload-bundle` holding `mtg-grimoire-<version>-android.aab`.

- [ ] **Step 1: `scripts/ci-route.mjs`**

Replace the arm `{ match: ["scripts/android-sign.sh"], jobs: ["frontend", "rust", "android"] },` and the comment above it with:

```js
  // The Android release's scripts (`sign-bundle.sh`, `StripSignature.java`, `proof.sh`,
  // `check-version.sh`). `release.yml`'s `android-sign` job signs a release's bundle with the
  // upload key, and **`android` runs the same script here first, on throwaway keys** — the only
  // run it gets before a release. `rust` because every arm that sets `android` sets `rust`;
  // `frontend` because `mobile/host.test.ts` and `scripts/release-rule.test.mjs` read two of
  // them as text. Above `scripts/*`, which would lint them and run nothing.
  { match: ["scripts/android-release/*"], jobs: ["frontend", "rust", "android"] },
```

- [ ] **Step 2: `.github/workflows/ci.yml` — the `android` job's steps**

Replace everything from the comment above `- name: Build the APK` down to and including the job's `actions/upload-artifact` step with:

```yaml
      # From `mobile/`, so the CLI finds `mobile/src-tauri/tauri.conf.json` — from the repository
      # root it finds the desktop's. `beforeBuildCommand` builds the light bundle into
      # `dist-mobile/` first. **One Gradle run, two outputs**: the APK, which is what installs on
      # a phone from this job's artifact, and the Android App Bundle, which is what Google Play
      # takes and what a release signs. `release.yml`'s `android` job runs this same line.
      - name: Build the APK and the bundle
        working-directory: mobile
        run: npx tauri android build --apk --aab --target aarch64 --ci

      - name: Report the APK
        shell: bash
        run: |
          set -euo pipefail
          apk=$(find mobile/src-tauri/gen/android/app/build/outputs/apk -name '*.apk' | head -1)
          [ -n "$apk" ] || { echo "the build produced no APK" >&2; exit 1; }
          bytes=$(stat -c %s "$apk")
          so=$(unzip -l "$apk" | awk '/lib\/arm64-v8a\/.*\.so$/ {print $1}' | head -1)
          echo "APK: $apk — $bytes bytes"
          {
            echo "### Light app APK (arm64, release, debug-signed)"
            echo
            echo "| | bytes | MiB |"
            echo "| --- | ---: | ---: |"
            echo "| APK | $bytes | $(awk "BEGIN {printf \"%.1f\", $bytes / 1048576}") |"
            echo "| \`libgrimoire_light_lib.so\`, uncompressed | ${so:-?} | $(awk "BEGIN {printf \"%.1f\", ${so:-0} / 1048576}") |"
          } >> "$GITHUB_STEP_SUMMARY"
          mkdir -p apk-out && cp "$apk" apk-out/mtg-grimoire-light-arm64.apk

      # The bundle a release would sign, and the version it would carry to Play: Android installs
      # an update only over a lower `versionCode`, and Play refuses a code it has seen.
      - name: Report the bundle, and hold it to its version
        shell: bash
        run: |
          set -euo pipefail
          VERSION=$(node -p "require('./mobile/src-tauri/tauri.conf.json').version")
          bash scripts/android-release/check-version.sh "$VERSION"
          aab=$(find mobile/src-tauri/gen/android/app/build/outputs/bundle -name '*.aab' | head -1)
          [ -n "$aab" ] || { echo "the build produced no bundle" >&2; exit 1; }
          bytes=$(stat -c %s "$aab")
          echo "bundle: $aab — $bytes bytes"
          {
            echo
            echo "| Android App Bundle (what Play takes) | $bytes | $(awk "BEGIN {printf \"%.1f\", $bytes / 1048576}") |"
          } >> "$GITHUB_STEP_SUMMARY"
          mkdir -p aab-out && cp "$aab" aab-out/mtg-grimoire-light-arm64.aab

      # **The release's signing, on keys nobody keeps.** `release.yml`'s `android-sign` job runs
      # `sign-bundle.sh` with the upload keystore, and a release is the wrong place to find out
      # that `keytool` words its answer differently or that a refusal leaves a file behind. So
      # the proof runs here first, over the bundle above: keys minted with a random password in
      # a temporary folder, one signing held to its fingerprint, and three refusals — another
      # key's fingerprint, a debug certificate, an archive that is not a bundle — each required
      # to exit non-zero and leave nothing. **Not a secret and not an artifact.**
      - name: Prove the release signing on throwaway keys
        run: bash scripts/android-release/proof.sh aab-out/mtg-grimoire-light-arm64.aab

      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: mtg-grimoire-light-arm64
          path: apk-out/mtg-grimoire-light-arm64.apk
          retention-days: 14
          if-no-files-found: error
```

If the first run answers that `--apk` and `--aab` cannot be given together, remove both flags from that one line **in both workflows and in `release-rule.test.mjs`** — with neither, the CLI builds both — and say so in the pull request.

In the job's header comment (the block that begins `# **The light app's Android host, built into an APK**`), replace the paragraph that begins `# **A release build, signed with the runner's debug key**` with:

```yaml
  # **A release build, signed with the runner's debug key** (`gen/android/app/build.gradle.kts`,
  # by hand): installable and the size a shipped build would be, but every runner mints its own
  # key, so one run's APK does not upgrade over another's. **What a release sends to Google Play
  # is this same build's bundle, re-signed with the owner's upload key**: `release.yml`'s
  # `android` job is this job's steps, and its `android-sign` job — which holds the key and
  # builds nothing — runs `scripts/android-release/sign-bundle.sh` over the result. No secret is
  # here, and none is needed: the signing a release depends on is proved, on throwaway keys, by
  # every pull request that can have changed the bundle.
```

- [ ] **Step 3: `.github/workflows/release.yml` — the `android` job**

Replace the job's header comment and its last three steps (`Build the APK`, `Find the APK`, `upload-artifact`) so the job reads, from its comment to its end:

```yaml
  # **The light app's Android build, at the tag** — `ci.yml`'s `android` job, step for step: the
  # same runner, JDK 21, NDK, toolchain action, cache key and `npx tauri android build`. It
  # holds no secret, so what Gradle signs with is the runner's debug key, exactly as in a pull
  # request. That signature never leaves this workflow: `android-sign` below replaces it on the
  # bundle, or nothing is handed on. The APK the same run makes stays in this job.
  #
  # **It runs whether or not there is a key to sign with.** A tag the Android app cannot be
  # built from is a release that would ship two hosts and not the third, and that is a red run,
  # not a skip.
```

and, after the unchanged `Swatinem/rust-cache` step:

```yaml
      # From `mobile/`, so the CLI finds the light host's `tauri.conf.json`, as in `ci.yml` — and
      # the same line, so a release runs a command every pull request ran.
      - name: Build the APK and the bundle
        working-directory: mobile
        run: npx tauri android build --apk --aab --target aarch64 --ci

      # The `versionName` and `versionCode` come from `tauri.conf.json`'s `version`, which
      # release-please bumped in the commit this run is on. Held here, before anything is signed:
      # a bundle that says another version is one Play Console refuses after the release has run.
      - name: Find the bundle, and hold it to the release's version
        shell: bash
        env:
          VERSION: ${{ needs.release-please.outputs.version }}
        run: |
          set -euo pipefail
          bash scripts/android-release/check-version.sh "$VERSION"
          aab=$(find mobile/src-tauri/gen/android/app/build/outputs/bundle -name '*.aab' | head -1)
          [ -n "$aab" ] || { echo "the build produced no bundle" >&2; exit 1; }
          mkdir -p aab-out && cp "$aab" aab-out/mtg-grimoire-light-arm64.aab
          ls -l aab-out

      # Handed to `android-sign`, and to nobody else: this is the debug-signed build, and its
      # name says so. Fourteen days, so a sign job that failed can be run again.
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: android-aab-debug-signed
          path: aab-out/mtg-grimoire-light-arm64.aab
          retention-days: 14
          if-no-files-found: error
```

- [ ] **Step 4: `.github/workflows/release.yml` — the `android-sign` job**

Replace the whole job, comment included, with:

```yaml
  # **The upload key, in a job of its own.** This is the one structural rule the removed `sign`
  # job left behind (docs/reference/ci-and-releases.md): a signing key never sits in a build
  # leg, because a build leg runs every npm lifecycle script, every cargo build script and every
  # Gradle plugin, and any of them can read a file or an environment. So this job runs none of
  # them — no `npm ci`, no cargo, no Gradle. It checks out the scripts, downloads the bundle the
  # job above built, and re-signs it with the JDK's own `jarsigner`
  # (`scripts/android-release/sign-bundle.sh`, which `ci.yml`'s `android` job proves on
  # throwaway keys in every pull request that can have changed the bundle).
  # `scripts/release-rule.test.mjs` holds the rule.
  #
  # **The signed bundle goes to Google Play, by the owner's hand, and nowhere else** (decided
  # 2026-10-07: Play is the only place the Android app is published). So this job attaches
  # nothing to the release and can write nothing to the repository: what it signed leaves as the
  # artifact `play-upload-bundle`, and the summary says where to upload it. **A release is
  # therefore not on phones when this run ends** — it is when the owner has uploaded the bundle
  # and Play has reviewed it.
  #
  # **It is an upload key.** Google holds the key Play signs installs with (Play App Signing)
  # and can reset this one if it is lost, so it is not the unrecoverable thing an APK's signing
  # key is. It is still held to a committed fingerprint
  # (`mobile/src-tauri/release-signer.sha256`): a keystore pasted into the settings by mistake
  # is refused here, by name, and not by Play Console after the release has run.
  #
  # **With no key it signs nothing and ends green**, saying so in the summary. **With some of
  # the three key values and not all, it fails**: that is a mistake in the settings, and a skip
  # would hide it for as long as nobody looked. **With a key and no committed fingerprint it
  # signs nothing either**, and says which.
  #
  # **`environment: release`**, and with it the key: a repository-level value is handed to any
  # workflow on any branch of this repository that asks for it, where an environment's is handed
  # only to a job that names the environment, from a branch the environment allows — `main`
  # alone, set up once by the owner (docs/reference/ci-and-releases.md).
  android-sign:
    name: android (sign for Play)
    needs: [release-please, android]
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment: release
    # Reads the checkout and the artifact. It uploads nothing to the release.
    permissions:
      contents: read
    steps:
      # The scripts, and the fingerprint the next step looks for. Nothing is installed.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # A job's `if:` cannot ask whether a value is set, so a step does and says what it found.
      # **It is told whether each is set, never what it is**: the expressions below are `true`
      # or `false`, so no key material is in this step's environment.
      - name: Is there a key to sign with, and a fingerprint to hold it to
        id: key
        shell: bash
        env:
          HAS_KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 != '' }}
          HAS_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD != '' }}
          HAS_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD != '' }}
          PIN: mobile/src-tauri/release-signer.sha256
        run: |
          set -euo pipefail
          missing=""
          found=0
          has() { if [ "$2" = true ]; then found=$((found + 1)); else missing="$missing $1"; fi; }
          has ANDROID_KEYSTORE_BASE64 "$HAS_KEYSTORE"
          has ANDROID_KEYSTORE_PASSWORD "$HAS_KEYSTORE_PASSWORD"
          has ANDROID_KEY_PASSWORD "$HAS_KEY_PASSWORD"
          if [ -n "$missing" ] && [ "$found" -gt 0 ]; then
            echo "Some of the upload key's values are set in the release environment and these are not:$missing" >&2
            echo "Set all three or none — docs/reference/ci-and-releases.md, 'What only the owner can do'." >&2
            exit 1
          fi
          if [ -z "$missing" ] && [ -f "$PIN" ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "present=false" >> "$GITHUB_OUTPUT"
          {
            echo "### Android bundle — not signed"
            echo
            if [ -n "$missing" ]; then
              echo "This release has **no bundle to upload to Google Play**. The \`release\` environment"
              echo "holds no upload key (\`ANDROID_KEYSTORE_BASE64\`, \`ANDROID_KEYSTORE_PASSWORD\`,"
              echo "\`ANDROID_KEY_PASSWORD\`), and Play takes no bundle signed with a runner's debug key."
            else
              echo "⚠️ This release has **no bundle to upload to Google Play, although the upload key is"
              echo "set**: this tag holds no \`$PIN\`. Without the certificate's fingerprint in the tree"
              echo "nothing says the key in the settings is the one Play Console knows. Commit the"
              echo "fingerprint; the next release signs a bundle."
            fi
            echo "The bundle was built at this tag, so the tag is known to build one."
            echo
            echo "\`docs/reference/ci-and-releases.md\`, *What only the owner can do*, has the commands."
          } >> "$GITHUB_STEP_SUMMARY"

      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        if: steps.key.outputs.present == 'true'
        with:
          name: android-aab-debug-signed
          path: aab-in

      # The only step the key reaches. The keystore is decoded into the runner's temp folder,
      # outside the checkout, readable by this user alone (`umask 077`), and deleted when the
      # step ends, however it ends. **The alias is a plain word and not a secret**: GitHub would
      # mask every `mtg-grimoire` in this job's log — the bundle's own name among them — if it
      # were one.
      - name: Sign the bundle with the upload key
        if: steps.key.outputs.present == 'true'
        shell: bash
        env:
          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
          ANDROID_KEY_ALIAS: mtg-grimoire
          ANDROID_SIGNER_PIN: mobile/src-tauri/release-signer.sha256
          VERSION: ${{ needs.release-please.outputs.version }}
        run: |
          set -euo pipefail
          : "${JAVA_HOME_21_X64:?the runner image did not set JAVA_HOME_21_X64}"
          export JAVA_HOME="$JAVA_HOME_21_X64"
          export ANDROID_KEYSTORE="$RUNNER_TEMP/release.keystore"
          trap 'rm -f "$ANDROID_KEYSTORE"' EXIT
          umask 077
          printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$ANDROID_KEYSTORE"
          aab="mtg-grimoire-$VERSION-android.aab"
          bash scripts/android-release/sign-bundle.sh aab-in/mtg-grimoire-light-arm64.aab "$aab"
          echo "SIGNED_AAB=$aab" >> "$GITHUB_ENV"
          IFS=. read -r major minor patch <<< "$VERSION"
          {
            echo
            echo "**Upload \`$aab\` to Play Console** — it is this run's artifact \`play-upload-bundle\`."
            echo "*Test and release* → the track → *Create new release*. Its versionCode is $((major * 1000000 + minor * 1000 + patch))."
            echo
            echo "Until it is uploaded and Play has reviewed it, phones stay on the previous version:"
            echo "\`docs/reference/ci-and-releases.md\`, *What only the owner can do*."
          } >> "$GITHUB_STEP_SUMMARY"

      # Thirty days: long enough for the owner to upload it, and not an archive — Play Console
      # keeps every bundle it was given. Anyone signed in to GitHub can download a public
      # repository's artifact; this one is no secret, and only the Console's owner can upload it.
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        if: steps.key.outputs.present == 'true'
        with:
          name: play-upload-bundle
          path: ${{ env.SIGNED_AAB }}
          retention-days: 30
          if-no-files-found: error
```

In `release.yml`'s file-header comment, replace the sentence `The two jobs that hold a secret — \`android-sign\`, \`web-deploy\` — build nothing, take what they` … through `… and each ends green and says so when its values are not set.` with the same sentence plus one more: `**The Android host leaves this workflow as a signed bundle the owner uploads to Google Play**; nothing Android is attached to the release.`

- [ ] **Step 5: Run the three fences and see them pass**

Run: `npx vitest run scripts/release-rule.test.mjs scripts/ci-route.test.mjs mobile/host.test.ts scripts/actions-pinned.test.mjs scripts/toolchain.test.mjs scripts/workflow-scripts.test.mjs`

Expected: PASS, every file. The usual first failure is `runs only what is listed here` naming an extra line: a non-comment line in `android-sign` that contains one of the words in Global Constraints. Reword the line; do not add it to the list.

---

### Task 4: The documents

**Files:**
- Modify: `.github/CLAUDE.md`
- Modify: `mobile/CLAUDE.md` (§5, the bullet beginning `Ships from the release tag`)
- Modify: `CLAUDE.md` (line 5)
- Modify: `docs/reference/ci-and-releases.md` (the release-rule table and bullets; *What only the owner can do*; the artifacts bullet)

`.github/CLAUDE.md` and `mobile/CLAUDE.md` are under a 200-line budget that CI enforces (`node scripts/check-claude-md.mjs`). These edits replace lines; they add none.

- [ ] **Step 1: `.github/CLAUDE.md`**

Replace each of these, exactly:

| Find | Replace with |
| --- | --- |
| ``- `scripts/android-sign.sh` routes to `frontend`, `rust`, and `android` (must sit above `scripts/*`);`` | ``- `scripts/android-release/*` routes to `frontend`, `rust`, and `android` (must sit above `scripts/*`);`` |
| the two lines of the **`android`** job bullet | ``  - **`android`**: Builds the light app on `ubuntu-24.04` via `npx tauri android build --apk --aab --target aarch64` with JDK 21 (debug-signed, no secret), holds it to its version (`scripts/android-release/check-version.sh`),`` / ``    then proves the release's signing by running `scripts/android-release/proof.sh` over the bundle: throwaway keys, one signing, three refusals.`` |
| ``  - `build` (desktop matrix), `android` (the APK, as `ci.yml` builds it) and `web` …`` | the same line with `(the APK, as `ci.yml` builds it)` → `(the APK and the bundle, as `ci.yml` builds them)` |
| the two `android-sign` lines | ``  - `android-sign` re-signs the bundle with the owner's **upload key** (`scripts/android-release/sign-bundle.sh`, `jarsigner`) and leaves `mtg-grimoire-<version>-android.aab` as the artifact `play-upload-bundle`, which the owner uploads to Play Console. Nothing Android is attached to the release.`` / ``    The key is held to the committed fingerprint `mobile/src-tauri/release-signer.sha256`: no file, no bundle; another key, a debug certificate or an archive that is not a bundle is refused.`` |
| `none → attach/deploy nothing, say so in the summary, end green; some but not all → fail. A debug-signed APK is never attached.` | `none → sign/deploy nothing, say so in the summary, end green; some but not all → fail. The Android app is published on Google Play only.` |
| ``- Artifacts built: … `.AppImage`, and — once the signing secrets exist — the Android `.apk`.`` | ``- Artifacts built: … `.AppImage`. The Android bundle is a workflow artifact, never a release asset.`` |

- [ ] **Step 2: `mobile/CLAUDE.md`**

Replace the bullet that begins `- Ships from the release tag, with the desktop and the web app:` with:

```markdown
- Ships from the release tag, with the desktop and the web app — **to Google Play, and nowhere else**: `release.yml` builds the bundle as CI does (debug-signed), and a job that holds the owner's upload key and builds nothing re-signs it (`scripts/android-release/sign-bundle.sh`) and leaves it as an artifact he uploads to Play Console. The Gradle project reads no keystore — never add a signing config or a `keystore.properties` to `gen/android`. `src-tauri/release-signer.sha256` (absent until the owner makes the key) is the upload certificate's public fingerprint: never regenerate or replace it without the owner (`host.test.ts`; [ci-and-releases.md](../docs/reference/ci-and-releases.md), "The release rule").
```

- [ ] **Step 3: `CLAUDE.md`**

Replace line 5:

```markdown
Also supports a light app (Android via Tauri, published on Google Play, and Web via WebAssembly in a Cloudflare Worker).
```

- [ ] **Step 4: `docs/reference/ci-and-releases.md` — the release rule**

This file is a record: keep its dated history, and add what changed. In the release-rule section:

Replace the two table rows for `android` and `android-sign` with:

```markdown
  | `android` | `release-please` | no | `ci.yml`'s `android` job, step for step: the arm64 APK and bundle at the tag, **debug-signed**, held to the tag's version (`scripts/android-release/check-version.sh`); the bundle handed on as the artifact `android-aab-debug-signed` (14 days) |
  | `android-sign` | `release-please`, `android` | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | Re-signs that bundle with the owner's upload key (`scripts/android-release/sign-bundle.sh`), held to the committed fingerprint, and leaves `mtg-grimoire-<version>-android.aab` as the artifact `play-upload-bundle` (30 days). Attaches nothing to the draft; `contents: read` |
```

Immediately after the table, insert this bullet as the first of the list:

```markdown
  - **Since 2026-10-07 the Android host goes to Google Play, and only there** (the owner's
    decision; `docs/superpowers/specs/2026-10-07-google-play-release-design.md`). What follows
    in this section was written for an APK attached to the release and signed with
    `apksigner`; three things changed and the rest stands. **A bundle, not an APK**: Play takes
    an Android App Bundle, so the build runs `tauri android build --apk --aab` and the bundle
    is what is signed. **`jarsigner`, not `apksigner`**: a bundle is signed as a JAR, and
    `jarsigner` *adds* a signer beside the build's debug one — so
    `scripts/android-release/StripSignature.java` takes the old signature off a copy first, and
    `sign-bundle.sh` refuses a result that does not verify, that names more or fewer than one
    signer, whose signer is not the keystore's, or whose entries are not the input's. It also
    refuses an archive with no `BundleConfig.pb` (an APK handed over by mistake), a debug
    certificate, and a keystore the pin does not name. **An upload key, not the signing key**:
    Google holds the key Play signs installs with and can reset an upload key, so the pin is a
    guard against the wrong keystore in the settings and no longer the last line before every
    phone uninstalls. **And the release rule's sentence changed with it**: the tag still
    *produces* all three hosts and `publish` still waits for `android-sign`, but the Android
    one reaches phones when the owner has uploaded the bundle and Play has reviewed it — hours
    to days behind the desktop and the web app, during which a phone holds a newer op exactly
    as any older build does. The version is held in the build leg now
    (`check-version.sh` reads the generated `tauri.properties`), because a bundle's manifest is
    a protocol buffer only `bundletool` reads. **Measured while this was written** (JDK 25,
    Git Bash, a fake bundle): the proof's one signing and three refusals; and that
    `keytool -printcert -jarfile` exits 1 with no signer for a bundle signed twice without the
    strip. **Not until a pull request**: the same on JDK 21 against a real bundle. **Not until
    a release**: the environment handing its values over, and Play Console accepting the
    result.
```

In the bullets below it, the paragraphs beginning `**`scripts/android-sign.sh` refuses to hand back an APK it cannot vouch for.**` and `**And it holds the key to the one every release has had.**` describe the removed script. Prefix each with `*(Until 2026-10-07, for the APK.)* ` and change nothing else in them.

- [ ] **Step 5: `docs/reference/ci-and-releases.md` — *What only the owner can do***

In the PowerShell block, replace step 1's and step 2's comments (the commands are unchanged) with:

```powershell
  # 1. The UPLOAD key — the key Play Console knows this account's uploads by. Google makes and
  #    keeps the key Play signs installs with (Play App Signing); this one only proves a bundle
  #    came from here. keytool asks for a password twice and for a name; a PKCS12 keystore (the
  #    default) has one password for the store and the key. The alias must be this one: the
  #    workflow names it.
```

```powershell
  # 2. Its certificate's fingerprint, into the repository. No release signs a bundle until this
  #    file is on `main`, and every release after is held to it. It is the SHA-256 Play Console
  #    shows under Test and release → App integrity → Upload key certificate, without the colons
  #    and in lower case — compare them after the first upload.
```

Replace the bullet beginning `- ⚠️ **Back the keystore and its password up` with:

```markdown
  - ⚠️ **Back the keystore and its password up, somewhere that is not this repository and not
    only this machine.** GitHub never gives a secret back. **A lost upload key is an
    inconvenience, not a catastrophe**: Play Console → *Test and release* → *App integrity* →
    *App signing* → *Request upload key reset*, with a new key's certificate; Google takes
    about two days, and no phone notices, because Play signs what phones install. Then the new
    fingerprint goes into `release-signer.sha256` by pull request and the three values are set
    again. The root `.gitignore` ignores `*.jks`, `*.keystore`, `*.p12`, `keystore.properties`
    and `*.aab` for the day one is made in here anyway. **The fingerprint file is the opposite:
    public, and meant to be committed.**
```

Replace the bullet beginning `- **The first release-signed APK does not install over a debug-signed one.**` with:

```markdown
  - **A Play install does not go over a CI artifact's debug-signed APK.** The owner's phone,
    and anything else running one, needs one uninstall — which wipes `user.db` and its paired
    identity — before the first install from Play. It is the last.
  - **After every release, the bundle is uploaded by hand**: the run's summary names the
    artifact (`play-upload-bundle`) and its versionCode. Play Console → *Test and release* →
    the track → *Create new release* → upload → roll out. Until then phones stay a version
    behind. (Uploading from this workflow is a later change, with its own design.)
```

- [ ] **Step 6: `docs/reference/ci-and-releases.md` — the artifacts bullet**

In the bullet beginning `- Artifacts per release:`, replace `— and, once the signing secrets exist, **`mtg-grimoire-<version>-android-arm64.apk`**, the light app (*The release rule*, above; no release has carried one yet).` with `. **Nothing Android is a release asset**: the light app's signed bundle is the workflow artifact `play-upload-bundle`, on its way to Google Play (*The release rule*, above).`

- [ ] **Step 7: Check the budgets**

Run: `node scripts/check-claude-md.mjs`

Expected: exit 0 — every `CLAUDE.md` at or under 200 lines.

---

### Task 5: Verify, commit, and the pull request

- [ ] **Step 1: Sweep for the removed script's name**

Run: `git grep -n "android-sign\.sh" -- . ":!docs/superpowers" ":!docs/reference/light-app.md"`

Expected: matches only in `docs/reference/ci-and-releases.md`, inside the paragraphs marked *(Until 2026-10-07, for the APK.)* and the dated record of #821. Any other match is a reference Task 3 or 4 missed. (`docs/reference/light-app.md` is phase 4's and phase 6's record of what was measured then; it is left as written.)

- [ ] **Step 2: Run the whole gate, once**

Run: `npm run verify`

Expected: exit 0. Never start a second `verify` while one runs — concurrent runs fake Rust schema failures.

- [ ] **Step 3: Commit**

```bash
git add -A scripts/android-release scripts/android-sign.sh scripts/ci-route.mjs scripts/ci-route.test.mjs scripts/release-rule.test.mjs mobile/host.test.ts .github/workflows/ci.yml .github/workflows/release.yml .gitignore .github/CLAUDE.md mobile/CLAUDE.md CLAUDE.md docs/reference/ci-and-releases.md docs/superpowers/specs/2026-10-07-google-play-release-design.md docs/superpowers/plans/2026-10-07-google-play-a-bundle-pipeline.md
git commit -m "$(cat <<'EOF'
feat(android): build and sign an app bundle for Google Play

The release builds the light app as an Android App Bundle and re-signs it
with the owner's upload key in a job that builds nothing. The signed bundle
leaves as a workflow artifact he uploads to Play Console; nothing Android is
attached to the GitHub release.

scripts/android-release/ replaces scripts/android-sign.sh: jarsigner over a
copy with the build's debug signature stripped, refused unless it verifies
with exactly the pinned signer and the input's own entries. ci.yml proves it
on throwaway keys in every pull request that can change the bundle.

Refs #761

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Open the pull request when the owner says to**

The first run of `ci.yml`'s `android` job on the pull request is the measurement this plan could not make: `--apk --aab` in one invocation, `check-version.sh` against a real `tauri.properties`, and the proof on JDK 21 against a real bundle. Read that job's log before calling the work done, and record what it said in `docs/reference/ci-and-releases.md` under the 2026-10-07 bullet, in the same commit (amend before the pull request is reviewed, or a `docs:` fix-up the owner squashes).

---

## What changed in execution (2026-10-07)

The plan above is as it was written. These are the decisions made while it was carried out —
each one where the code now differs from a task's text, or where something found in review was
fixed or knowingly left. Where the two disagree, the code and this list are right.

- tasks make WIP commits and the controller squashes the branch into the plan's one conventional commit before the PR — the review loop needs a commit range per task and the repo wants one commit per feature — costs a soft reset on a private branch if wrong.
- the controller runs `npm run verify`, one worktree at a time, with one shared CARGO_TARGET_DIR (D:\Code\mtg-grimoire\.claude\worktrees\gp-target); no implementer runs verify — two verifies at once fake Rust failures (memory) — costs a late finding if a task's own focused tests missed something.
- the plan's final commit step is the controller's (the squash); the last task's implementer does the sweep and the documents only.
- merge order is A, then B, then C; B and C merge main and resolve the shared files (mobile/host.test.ts, mobile/CLAUDE.md, docs/reference/light-app.md) when their turn comes — costs a small manual merge.
- Tasks 2 and 3 are one dispatch and one review — Task 2 alone leaves the fences red by design, so it is not a reviewable deliverable — costs one larger diff to review.
- **Task 1.** both Important findings contradict the plan's verbatim script text and are right — IN==OUT refusal deleted its input; the proof's "nothing left behind" assertions could not fail — the scripts are fixed and the plan's copy of them is superseded by the code — costs nothing if wrong beyond a fix round.
- the review's Minors 1-4 (stale comments in release.yml at ~548/~692/~706, build.gradle.kts:45, ci-route.test.mjs's comment; the bundle row breaking the CI summary table) are folded into Task 4's dispatch — Task 4 is the "say what is now true" task and they are comments this change made untrue — costs a wider Task 4 diff.
- **Task 4.** "three refusals" was true when the plan was written and stopped being true at Task 1's fix round (the IN==OUT case) — the documents follow the code, four — costs nothing.
- **Task 4.** the five Minors (publish comment vs no-key case; two "APK" in live prose; "three things changed" over four items; the summary table's heading) join fix round 1 — each is an untrue word in a file this task owns — costs a slightly wider re-review.
- one fix wave takes all four Importants and the reviewer's Minors that are one-line truths or free hardening (stale doc sentences; the re-run note; "distributed through" not "published on"; "one command"; "no other job"; the runbook's zip and keytool-name notes; ::error:: in die; check-version's comment; java/jarsigner/keytool in the fence's word list; retention fenced; proof's exportcert || fail; unset the base64 after decoding; claim 4) — costs a wider fix diff, re-reviewed once.
- sign-bundle.sh's six deferred Minors stay as they are, on the final reviewer's reasons (each fails closed or cannot strand an unverified output) — costs nothing known.
- artifact integrity between android and android-sign (a digest as a job output) is not in this change — not a regression, and it belongs with the API-upload design — costs: a compromised build leg could swap the bundle, as it already could the desktop installers.
- after the fix wave the controller re-runs the proof, the fence files, eslint on the changed test files and the CLAUDE.md check — not a second full verify: the wave touches no Rust and no app code — costs a missed interaction only if a fence file breaks another suite, which CI's frontend job would show.
- one follow-up line goes back to the same fix agent, outside the one-wave rule — the annotation noise was introduced by the wave at the controller's own instruction (F5b), it would show on every pull request, and the change is confined to proof.sh's redirection; the controller verifies it by running the proof — costs: a second touch after the single re-review, checked by command output rather than by a reviewer.
- **left as it is.** the proof's own one-signer assertion is a second line of defence, never reached under the strip-skipped mutation because sign-bundle.sh refuses first — real, kept, not separately proven.
- **left as it is.** `path: aab-in` in the fence is a prefix match — negligible.
