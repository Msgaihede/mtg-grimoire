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
# for this build; `scripts/release-rule.test.mjs` holds the Gradle project's `versionCode`
# line to reading it.
set -euo pipefail

VERSION=${1:?usage: check-version.sh <x.y.z> [<tauri.properties>]}
PROPS=${2:-apps/light/src-tauri/gen/android/app/tauri.properties}

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
