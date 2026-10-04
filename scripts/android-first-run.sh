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
# databases' size on the device; a screenshot of the phone face; three cold starts, each after a
# `force-stop`; and then **leaving the app**, twice — by the back gesture from the start page, and
# by the activity being destroyed — each watched in logcat for the teardown abort a phone showed
# (below). Everything goes to `$GITHUB_STEP_SUMMARY` and to `<out-dir>`, which the workflow
# uploads.
#
# **Exits non-zero when there is no ingest figure** — a launch whose downloads were held (a
# metered network), a sync that failed, or one that ran past the timeout — after writing what it
# did measure. A measurement step that went green with no number in it would read as a number.
# **And when leaving the app aborted it** — a `FORTIFY` line, a destroyed mutex or a fatal signal
# in the app's process.
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

# --- Leaving the app -----------------------------------------------------------------------------
# A phone (a OnePlus on Android 16, a release APK, 2026-10-04) ended the process each time the
# back gesture left the app from its start page: `FORTIFY: pthread_mutex_lock called on a destroyed
# mutex`, then `has died`. A destroyed activity ends Tauri's event loop, and tao's
# `EventLoop::run` calls `std::process::exit`, whose static destructors race the framework's live
# threads. Two fixes, one check each: `MainActivity.kt` moves the task to the back on the last back
# rather than letting it finish, and the host ends the process with `_exit` when the activity is
# destroyed some other way (`lib.rs`, `end_on_exit`). Stock Android 12+ already moves a root
# launcher task to the back, so the first check cannot fail here the way the phone did; the second
# destroys the activity on purpose, which is the phone's path whatever destroyed it there.
LEAVE_WAIT_S=8
EXIT_LINE="host: the window is gone; ending the process with _exit"

app_pid() { { adb shell pidof "$PKG" || true; } | tr -d '\r'; }

# Clear the buffers, run the command, wait, and keep everything the device logged since.
watch_leaving() { # <name> <command...>
  local name=$1
  shift
  adb logcat -b main -b system -b crash -b events -c || true
  "$@" || true
  sleep "$LEAVE_WAIT_S"
  adb logcat -d -v epoch -b main -b system -b crash -b events > "$OUT/leave-$name.log" 2>&1 || true
}

# The lines that say a teardown went wrong in process <pid>: bionic's FORTIFY abort and the fatal
# signal behind it. With `-v epoch` the second field is the logging process's id.
aborts() { # <log> <pid>
  { grep -E 'FORTIFY|destroyed mutex|Fatal signal' "$1" || true; } \
    | awk -v pid="$2" '$2 == pid || index($0, "pid " pid " ") || index($0, "pid: " pid)'
}

# Whether the system destroyed the activity in that window — its own event log line.
destroyed() { grep -q "wm_destroy_activity.*$ACTIVITY" "$1" && echo yes || echo no; }

press_back_twice() {
  adb shell input keyevent KEYCODE_BACK
  sleep 2
  adb shell input keyevent KEYCODE_BACK
}

# One launch's `TotalTime` and `LaunchState` (HOT when the activity was kept, COLD when the process
# was not), as "<ms> <state>".
launch_with_state() {
  local out
  out=$({ adb shell am start -W -n "$ACTIVITY" || true; } | tee -a "$OUT/am-start.txt")
  printf '%s %s\n' \
    "$(awk -F': *' '/^TotalTime/ {gsub(/\r/, "", $2); print $2}' <<< "$out")" \
    "$(awk -F': *' '/^LaunchState/ {gsub(/\r/, "", $2); print $2}' <<< "$out")"
}

# 1. The back gesture from the start page — the phone's own press. The app is ten seconds into a
#    cold start nobody has touched, so the WebView has no history; the second press is for a first
#    entry the page's history took after all, and lands on the home screen otherwise.
back_pid=$(app_pid)
back_alive="" back_destroyed="" back_aborts="" return_ms="" return_state=""
if [ -n "$back_pid" ]; then
  watch_leaving back press_back_twice
  back_aborts=$(aborts "$OUT/leave-back.log" "$back_pid")
  back_destroyed=$(destroyed "$OUT/leave-back.log")
  if [ "$(app_pid)" = "$back_pid" ]; then back_alive=yes; else back_alive=no; fi
  read -r return_ms return_state <<< "$(launch_with_state)" || true
  sleep 10
else
  back_alive="the app was not running"
fi

# 2. The activity destroyed under a running process — what the phone's back did. "Don't keep
#    activities" destroys it as Home stops it; where an image does not honour the setting at
#    runtime, a launch that clears the task finishes it instead.
destroy_pid=$(app_pid)
destroy_how="" destroy_ended="" destroy_exit_line="" destroy_aborts=""
if [ -n "$destroy_pid" ]; then
  adb shell settings put global always_finish_activities 1 || true
  watch_leaving destroy adb shell input keyevent KEYCODE_HOME
  adb shell settings put global always_finish_activities 0 || true
  destroy_how="Don't keep activities, then Home"
  if [ "$(destroyed "$OUT/leave-destroy.log")" = no ]; then
    mv "$OUT/leave-destroy.log" "$OUT/leave-destroy-home.log"
    destroy_how="a launch with \`--activity-clear-task\` (Don't keep activities was not honoured)"
    watch_leaving destroy adb shell am start -n "$ACTIVITY" --activity-clear-task
  fi
  if [ "$(destroyed "$OUT/leave-destroy.log")" = no ]; then
    destroy_how="not exercised: $destroy_how left the activity standing"
  fi
  destroy_aborts=$(aborts "$OUT/leave-destroy.log" "$destroy_pid")
  if [ "$(app_pid)" = "$destroy_pid" ]; then destroy_ended=no; else destroy_ended=yes; fi
  if grep -qF "$EXIT_LINE" "$OUT/leave-destroy.log"; then destroy_exit_line=yes; else destroy_exit_line=no; fi
else
  destroy_how="not exercised: the app was not running"
fi

leave_aborts=$(printf '%s\n%s\n' "$back_aborts" "$destroy_aborts" | sed '/^$/d')

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
yes_if() { [ -n "$1" ] && echo '**yes**' || echo none; }
note ""
note "#### Leaving the app"
note ""
note "| | value |"
note "| --- | --- |"
note "| Back ×2 from the start page: process kept | $(or_dash "$back_alive") |"
note "| Back ×2 from the start page: activity destroyed | $(or_dash "$back_destroyed") |"
note "| Back ×2 from the start page: teardown abort | $(yes_if "$back_aborts") |"
note "| Return after the back, \`TotalTime\` / \`LaunchState\` | $(or_dash "$return_ms") ms / $(or_dash "$return_state") |"
note "| Activity destroyed by | $destroy_how |"
note "| Activity destroyed: process ended | $(or_dash "$destroy_ended") |"
note "| Activity destroyed: the host's \`_exit\` line in logcat | $(or_dash "$destroy_exit_line") |"
note "| Activity destroyed: teardown abort | $(yes_if "$destroy_aborts") |"
if [ -n "$leave_aborts" ]; then
  note ""
  note "Leaving the app aborted it:"
  note ""
  note '```'
  note "$leave_aborts"
  note '```'
fi
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
  --arg back_alive "$back_alive" --arg back_destroyed "$back_destroyed" \
  --arg back_aborts "$back_aborts" --arg return_ms "$return_ms" --arg return_state "$return_state" \
  --arg destroy_how "$destroy_how" --arg destroy_ended "$destroy_ended" \
  --arg destroy_exit_line "$destroy_exit_line" --arg destroy_aborts "$destroy_aborts" \
  'def n: if . == "" then null else tonumber end;
   def s: if . == "" then null else . end;
   { outcome: $outcome, apk_bytes: ($apk|n), so_bytes: ($so|n), install_ms: ($install|n),
     first_launch_ms: ($first|n), ingest_ms: ($ingest|n), ingest_wall_ms: ($wall|n),
     corpus_db_bytes: ($corpus|n), user_db_bytes: ($user|n), app_data_kib: ($app|n),
     cold_start_ms: [$c1, $c2, $c3 | n], cold_start_median_ms: ($median|n),
     private_read: (if $private == "" then null else $private end),
     leaving: {
       back: { process_kept: ($back_alive|s), activity_destroyed: ($back_destroyed|s),
               aborts: ($back_aborts|s), return_ms: ($return_ms|n), return_state: ($return_state|s) },
       destroyed: { how: $destroy_how, process_ended: ($destroy_ended|s),
                    exit_line: ($destroy_exit_line|s), aborts: ($destroy_aborts|s) } } }' \
  > "$OUT/first-run.json"

status=0
[ "$outcome" = "finished" ] || { echo "No ingest figure: $outcome" >&2; status=1; }
if [ -n "$leave_aborts" ]; then
  printf 'Leaving the app aborted it:\n%s\n' "$leave_aborts" >&2
  status=1
fi
exit "$status"
