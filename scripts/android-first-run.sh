#!/usr/bin/env bash
# The light app's first run, measured on an emulator — `.github/workflows/android-emulator.yml`,
# phase 4, step 4.5. Runs inside `reactivecircus/android-emulator-runner`'s `script:` with one
# booted device on `adb`:
#
#   bash scripts/android-first-run.sh <apk> <out-dir>
#
# It installs the APK and measures, in this order: the APK and its `.so`; the first launch, which
# also creates the databases; the first corpus ingest, from that launch until the host prints
# `launch: card sync finished in N ms` (`mobile/src-tauri/src/lib.rs`, `spawn_downloads`); the two
# databases' size on the device; a screenshot of the phone face; and three cold starts, each
# after a `force-stop`. Everything goes to `$GITHUB_STEP_SUMMARY` and to `<out-dir>`, which the
# workflow uploads.
#
# **Exits non-zero when there is no ingest figure** — a launch whose downloads were held (a
# metered network), a sync that failed, or one that ran past the timeout — after writing what it
# did measure. A measurement step that went green with no number in it would read as a number.
#
# The host's lines reach logcat because Tauri's Android shell (tao's `ndk_glue::create`) pipes
# stdout and stderr there, tagged `RustStdoutStderr`, in a release build as in a debug one.
set -euo pipefail

APK=${1:?usage: android-first-run.sh <apk> <out-dir>}
OUT=${2:?usage: android-first-run.sh <apk> <out-dir>}
PKG=com.mtggrimoire.app
ACTIVITY=$PKG/.MainActivity
# Where `app_data_dir()` lands on Android: Tauri's `PathPlugin.getDataDir` answers the activity's
# `dataDir`, and the host opens `data/` under it (`lib.rs`, `data_dir`).
DATA=/data/data/$PKG/data
STARTED_WITHIN_S=60
INGEST_TIMEOUT_S=$((45 * 60))
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/stdout}

mkdir -p "$OUT"
LOG="$OUT/rust-stderr.log"

now_ms() { date +%s%3N; }
note() { echo "$*" | tee -a "$OUT/summary.md" >> "$SUMMARY"; }

# One `am start -W` and its `TotalTime`, in ms — the time to the activity's first frame. Empty when
# the line is missing, which the report says rather than inventing a zero.
launch() {
  { adb shell am start -W -n "$ACTIVITY" || true; } | tee -a "$OUT/am-start.txt" \
    | awk -F': *' '/^TotalTime/ {gsub(/\r/, "", $2); print $2}'
}

# --- The APK -------------------------------------------------------------------------------------
apk_bytes=$(stat -c %s "$APK")
so_bytes=$({ unzip -l "$APK" || true; } | awk '/lib\/x86_64\/.*\.so$/ {print $1}' | head -1)

# Root first, before anything else is running: `adb root` restarts adbd, which would cut off the
# logcat reader below. It returns before adbd has restarted, so the wait alone can succeed on the
# old connection.
rooted=""
if adb root > /dev/null 2>&1 && sleep 3 && adb wait-for-device \
  && [ "$(adb shell id -u | tr -d '\r')" = 0 ]; then
  rooted=yes
fi

# The screen stays on for the whole run: a screen timeout would stop the activity, which is not
# what a reader watching a first ingest has.
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 2147483647
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard || true
adb shell dumpsys connectivity > "$OUT/connectivity.txt" 2>&1 || true

t=$(now_ms)
adb install -r "$APK" > /dev/null
install_ms=$(($(now_ms) - t))

# A shell on the device that can read the app's private folder: adbd as root on a `google_apis`
# image, `run-as` on a debuggable build (asked once the package is installed), or neither — a
# release build on a locked image.
device_sh=""
if [ -n "$rooted" ]; then
  device_sh="root"
elif adb shell run-as "$PKG" true > /dev/null 2>&1; then
  device_sh="run-as"
fi
private() {
  case "$device_sh" in
    root) adb shell "$1" ;;
    run-as) adb shell run-as "$PKG" sh -c "'$1'" ;;
    *) return 1 ;;
  esac
}

# --- The first launch and the first ingest -------------------------------------------------------
adb logcat -c
# Into a file from before the launch: logcat's ring buffer can turn over in 45 minutes, and the
# `started` line is the one that would be lost.
adb logcat -v epoch -s RustStdoutStderr:I > "$LOG" 2>&1 &
logcat_pid=$!
trap 'kill "$logcat_pid" 2> /dev/null || true' EXIT

launched_at=$(now_ms)
first_launch_ms=$(launch)

started=""
for _ in $(seq 1 $((STARTED_WITHIN_S / 2))); do
  if grep -q "launch: card sync started" "$LOG"; then started=yes; break; fi
  sleep 2
done

ingest_ms=""
ingest_wall_ms=""
outcome=""
if [ -z "$started" ]; then
  if adb shell pidof "$PKG" > /dev/null 2>&1; then
    outcome="held — the emulator reported a metered network"
  else
    outcome="the app died before the card sync started"
  fi
else
  deadline=$(($(date +%s) + INGEST_TIMEOUT_S))
  while :; do
    if line=$(grep -m1 "launch: card sync finished in" "$LOG"); then
      ingest_wall_ms=$(($(now_ms) - launched_at))
      ingest_ms=$(sed -n 's/.*card sync finished in \([0-9]*\) ms.*/\1/p' <<< "$line")
      outcome="finished"
      break
    fi
    if line=$(grep -m1 "initial sync failed" "$LOG"); then
      outcome="failed — ${line#*initial sync failed: }"
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      outcome="still running after $((INGEST_TIMEOUT_S / 60)) minutes"
      break
    fi
    sleep 10
  done
fi

# --- What the ingest left on the device ----------------------------------------------------------
corpus_bytes="" user_bytes="" app_kib=""
if [ -n "$device_sh" ]; then
  private "ls -l $DATA" > "$OUT/data-dir.txt" 2>&1 || true
  corpus_bytes=$(private "stat -c %s $DATA/corpus.db" 2> /dev/null | tr -d '\r' || true)
  user_bytes=$(private "stat -c %s $DATA/user.db" 2> /dev/null | tr -d '\r' || true)
  app_kib=$(private "du -sk /data/data/$PKG" 2> /dev/null | awk '{print $1}' || true)
fi

# A few seconds for the page to draw what the sync brought, then the phone face as it stands.
sleep 10
adb exec-out screencap -p > "$OUT/after-ingest.png" || true

# --- Three cold starts ---------------------------------------------------------------------------
# Process-cold, not cache-cold: the page cache still holds the APK and the databases, which a
# phone's first launch of the day may not.
cold=()
for _ in 1 2 3; do
  adb shell am force-stop "$PKG"
  sleep 5
  cold+=("$(launch)")
  sleep 10
done
cold_median=$(printf '%s\n' "${cold[@]}" | grep -E '^[0-9]+$' | sort -n | sed -n 2p)
adb exec-out screencap -p > "$OUT/after-cold-start.png" || true

# --- The report ----------------------------------------------------------------------------------
mib() { [ -n "$1" ] && awk "BEGIN {printf \"%.1f\", $1 / 1048576}" || echo "—"; }
or_dash() { [ -n "$1" ] && echo "$1" || echo "—"; }
db_note=""
[ -z "$device_sh" ] && db_note=" (not measurable on a release build: no root and no \`run-as\`)"

note "### Light app, first run on an emulator (x86_64, release, debug-signed)"
note ""
note "Outcome of the first ingest: **$outcome**. A first launch also creates the databases."
note ""
note "| | value |"
note "| --- | ---: |"
note "| APK | $apk_bytes bytes ($(mib "$apk_bytes") MiB) |"
note "| \`libgrimoire_light_lib.so\`, uncompressed | $(or_dash "$so_bytes") bytes ($(mib "$so_bytes") MiB) |"
note "| \`adb install\` | $install_ms ms |"
note "| First launch, \`TotalTime\` | $(or_dash "$first_launch_ms") ms |"
note "| First corpus ingest, the host's own figure | $(or_dash "$ingest_ms") ms |"
note "| First launch to the \`finished\` line, wall clock (±10 s) | $(or_dash "$ingest_wall_ms") ms |"
note "| \`corpus.db\` after the ingest$db_note | $(or_dash "$corpus_bytes") bytes ($(mib "$corpus_bytes") MiB) |"
note "| \`user.db\` after the ingest$db_note | $(or_dash "$user_bytes") bytes |"
note "| The app's whole data folder | $(or_dash "$app_kib") KiB |"
note "| Cold start after \`force-stop\`, \`TotalTime\` ×3 | $(printf '%s, ' "${cold[@]}" | sed 's/, $//') ms |"
note "| Cold start, median | $(or_dash "$cold_median") ms |"
note ""
note "Private folder read through: $(or_dash "$device_sh")."
if [ "$outcome" != "finished" ]; then
  note ""
  note "The host's last lines on stderr:"
  note ""
  note '```'
  note "$(tail -n 20 "$LOG")"
  note '```'
fi

jq -n \
  --arg outcome "$outcome" \
  --arg apk "$apk_bytes" --arg so "$so_bytes" --arg install "$install_ms" \
  --arg first "$first_launch_ms" --arg ingest "$ingest_ms" --arg wall "$ingest_wall_ms" \
  --arg corpus "$corpus_bytes" --arg user "$user_bytes" --arg app "$app_kib" \
  --arg c1 "${cold[0]}" --arg c2 "${cold[1]}" --arg c3 "${cold[2]}" --arg median "$cold_median" \
  --arg private "$device_sh" \
  'def n: if . == "" then null else tonumber end;
   { outcome: $outcome, apk_bytes: ($apk|n), so_bytes: ($so|n), install_ms: ($install|n),
     first_launch_ms: ($first|n), ingest_ms: ($ingest|n), ingest_wall_ms: ($wall|n),
     corpus_db_bytes: ($corpus|n), user_db_bytes: ($user|n), app_data_kib: ($app|n),
     cold_start_ms: [$c1, $c2, $c3 | n], cold_start_median_ms: ($median|n),
     private_read: (if $private == "" then null else $private end) }' > "$OUT/first-run.json"

[ "$outcome" = "finished" ] || { echo "No ingest figure: $outcome" >&2; exit 1; }
