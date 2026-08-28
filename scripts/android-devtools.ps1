# Forward the running app's WebView DevTools socket to a local port, so `scripts/cdp.mjs` can
# drive the phone exactly as it drives the desktop window. `cdp.mjs` already reads `CDP_PORT`
# (scripts/cdp.mjs:32), so the harness itself needs no change.
#
# CDP_PORT 9444 rather than 9222: 9222 is the desktop app's and 9223 is the MCP bridge's. Both
# are hardcoded in tracked files and must not be remapped, so this takes a fourth port.
#
# **The socket name is discovered, never hardcoded.** Android names it after the process id, so
# it changes on every launch — a script with a fixed name works once and then silently forwards
# nothing, which reads as "the app is broken" rather than "the port moved".
#
# **Debug builds only.** A release WebView publishes no socket at all unless the app calls
# `WebView.setWebContentsDebuggingEnabled(true)`, which this one does not. `tauri android dev`
# and `tauri android build --debug` both produce a debug build, and the package they install
# carries the `.debug` suffix from `tauri.conf.json`'s `bundle.android`.
#
# **Verified on the device, against another app's WebView — not against this app.** On
# 2026-08-28 the OnePlus 12 (CPH2581, Android 16, SDK 36) was driven end to end with
# `-Package ac.cloud.com`: `/proc/net/unix` is readable by the `shell` user, the socket really
# is named `webview_devtools_remote_<pid>`, the forward succeeded, and
# `http://127.0.0.1:9444/json/version` answered 200 with a `webSocketDebuggerUrl`. The three
# refusals below (no adb, no device, package not running) were each run and each left with
# their own exit code.
#
# What is NOT verified is this app: no APK has ever been built, because Gradle 8.14.3 / AGP
# 8.11.0 / KGP 1.9.25 all refuse the JDK 25 that is the only one on this machine. So the
# `$Package` default is a prediction — it is `tauri.conf.json`'s identifier plus the
# `.debug` suffix from `bundle.android.debugApplicationIdSuffix` — and nothing has confirmed
# the app publishes a socket at all.
#
# **The two Stetho sockets on that device are why the pid filter exists rather than a
# first-match.** `@stetho_com.google.android.apps.messaging_devtools_remote` also ends in
# `devtools_remote`, and a script that took the first hit would have forwarded a text-messaging
# app's debugger and reported success.
param(
  [string]$Package = "com.mtggrimoire.app.debug",
  [int]$Port = 9444,
  [string]$Adb = "C:\Users\Markus\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe"
)

$ErrorActionPreference = "Stop"

# **`Write-Error` under `ErrorActionPreference = Stop` throws, so an `exit` after one never
# runs** — every refusal below reported a generic failure and no exit code at all until this
# was found by running the script rather than reading it. This writes the sentence to stderr
# and then leaves with the code that names which refusal it was.
function Fail([string]$Message, [int]$Code) {
  # `[Console]::Error` rather than `Write-Error`, because `Write-Error` raises an error record
  # that `ErrorActionPreference = Stop` turns into a terminating error before the `exit` below
  # can run — and `-ErrorAction Continue` on it does not override the preference here. Writing
  # the bytes to stderr directly has no error-stream semantics to argue with, so the exit code
  # is the one this function was given. Both halves were found by running the script.
  [Console]::Error.WriteLine($Message)
  exit $Code
}

if (-not (Test-Path $Adb)) {
  Fail "adb not found at $Adb. It ships with the Android SDK platform-tools; pass -Adb to point at another copy." 2
}

# `adb devices` lists a header even with nothing attached, so the count is what answers rather
# than the exit code — which is 0 either way.
$attached = (& $Adb devices) | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice$" }
if (-not $attached) {
  Fail "No device attached. Plug the phone in, enable USB debugging, and accept the RSA fingerprint on the device." 3
}

# `pidof` answers empty for a package that is not running, and `adb forward` succeeds against a
# socket that does not exist — so this has to be checked before the forward, not after.
$appPid = (& $Adb shell pidof $Package)
if ($appPid) { $appPid = $appPid.Trim() }
if (-not $appPid) {
  Fail "$Package is not running on the device. Launch it (npm run tauri android dev) and try again." 4
}

$sockets = (& $Adb shell "cat /proc/net/unix") | Where-Object { $_ -match "devtools_remote" }
if (-not $sockets) {
  Fail "No devtools socket on the device. Is this a DEBUG build? A release WebView does not publish one unless setWebContentsDebuggingEnabled(true)." 5
}
Write-Host "sockets found:"
$sockets | ForEach-Object { "  $_" }

# The app's own, matched by pid. Android's convention is `webview_devtools_remote_<pid>`, but
# the convention is not a measurement — so the pid is what selects, and the whole list is
# printed above for the case where nothing matches.
$name = ($sockets | ForEach-Object {
  if ($_ -match "([A-Za-z0-9_]*devtools_remote[A-Za-z0-9_]*)") { $Matches[1] }
}) | Where-Object { $_ -like "*_$appPid" } | Select-Object -First 1

if (-not $name) {
  Fail "No devtools socket matched pid $appPid. The sockets above are what the device offers; name one by hand with adb forward if the convention has moved." 6
}

# `adb forward` echoes the port it bound; the line below says it better.
& $Adb forward "tcp:$Port" "localabstract:$name" | Out-Null
Write-Host "forwarded tcp:$Port -> localabstract:$name"
Write-Host ""
Write-Host "now:"
Write-Host "  `$env:CDP_PORT = '$Port'"
Write-Host "  node scripts/cdp.mjs eval `"location.href`""
Write-Host ""
Write-Host "and for the Rust side, which has no console on a phone:"
Write-Host "  & '$Adb' logcat -s RustStdoutStderr:*"
