# The Android target

**Android is native, and the wasm constraints belong to Web alone.** Tauri's mobile target
compiles this same crate for `aarch64-linux-android` and runs `dist/` in the system WebView, so
it gets `rusqlite` with `bundled`, a real filesystem, `tokio`, threads and WAL. OPFS, the
single connection, the rollback journal and the push parser are the web target's problems and
none of them apply here. A plan or a review that treats this as a wasm port is wrong from its
first line.

Every figure below was taken on **2026-08-28** on this machine (Windows 11, `x86_64`) and on the
**OnePlus 12 (CPH2581, Android 16, SDK 36, `arm64-v8a`)**. That phone is a flagship, so **every
device number is an optimistic bound** and is labelled as one. The build is named on each.

---

## 1. What this PR reached, and what it did not

| | |
| --- | --- |
| The crate compiles for `aarch64-linux-android` | ✅ `cargo build --target aarch64-linux-android --lib`, zero errors, zero warnings |
| `libsqlite3-sys` (`bundled`) against the NDK | ✅ — the riskiest compile in the whole target, and it works untouched |
| `ring` against the NDK | ✅ — so HTTPS needs no cert plumbing and no cmake |
| The Gradle project | ✅ generated and committed |
| **An APK** | ⛔ **blocked on the JDK** — see §2 |
| The app on the phone | ⛔ blocked on the APK |
| The three pickers against a real ContentResolver | ⛔ blocked on the APK |
| The CDP harness | 🟡 the forwarding script is verified on the device against **another app's** WebView; never against this app |

**Nothing in this repo has ever run on a phone.** Every Android claim here is either a
compile-time fact, a fact about the device measured directly with `adb`, or a reading of a
vendored crate's source. Where it is a prediction, it says so.

## 2. The toolchain, and the one thing that blocks it

**`npx tauri`, never `cargo tauri`.** The CLI on this machine is npm's `@tauri-apps/cli`
2.11.4; `cargo tauri --version` exits 101 with `no such command`.

| Piece | What was installed | Where |
| --- | --- | --- |
| Android SDK cmdline-tools | `commandlinetools-win-15859902_latest.zip`, 148.4 MB, SHA-256 verified | `C:\Android\Sdk\cmdline-tools\latest` |
| Platform | `platforms;android-36` | `C:\Android\Sdk` |
| Build-tools | `build-tools;36.0.0` | `C:\Android\Sdk` |
| Platform-tools | `platform-tools` 37.0.1 (a second copy; `adb` also lives under WinGet) | `C:\Android\Sdk` |
| NDK | **`ndk;27.3.13750724` (r27d)**, 2.20 GB — nothing in this repo or in the CLI pins a revision, so this is a choice: the newest r27, which is the family AGP 8.11 defaults to | `C:\Android\Sdk\ndk\27.3.13750724` |
| Rust targets | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` — 510 MB for the four | `~/.rustup` |

**Disk cost: 4.48 GB on `C:`** (189.36 → 184.88 GB free), plus 1.29 GB of build artifacts on
`D:`. **One licence was accepted, `android-sdk-license`, the standard Android SDK licence** —
`C:\Android\Sdk\licenses\` holds that and nothing else. No account was created and nothing was
signed on anyone's behalf.

**`ANDROID_HOME` and `NDK_HOME` are the two variable names the Tauri CLI reads.** Both appear
as literal strings in `cli.win32-x64-msvc.node`; `ANDROID_NDK_ROOT` does not, so setting only
that one is a silent no-op. Neither was set machine-wide — they are per-shell.

### The JDK, which is the blocker

`JAVA_HOME` is `C:\Program Files\OpenJDK\jdk-25`, and **that is the only JDK on this machine** —
a recursive sweep for `javac.exe` across `Program Files`, `Program Files (x86)`,
`%LOCALAPPDATA%\Programs`, `~/.jdks`, `~/.gradle/jdks` and `D:\` finds exactly one. The
Adoptium install on `PATH` is a **JRE**, so the obvious escape ("point `JAVA_HOME` at the 21
that is already here") does not exist.

The CLI's own pins, read out of the binary: **AGP 8.11.0, Gradle 8.14.3, KGP 1.9.25,
`compileSdk`/`targetSdk` 36, `minSdk` 21**. The generated project matches all five exactly.

**JDK 25 fails, measured at three layers rather than predicted:**

| Layer | What happens |
| --- | --- |
| `sdkmanager.bat` | Refuses with `Java version 17 or higher is required` — a **parser bug**: it splits `"25"` on `.`, gets no second component, computes `25` and compares against `170`. Google's own documented override, `SKIP_JDK_VERSION_CHECK=1`, gets past it and the SDK installs fine. |
| Gradle 8.14.3 itself | **Launches.** `gradle --version` reports `Launcher JVM: 25`. Its release notes say "Java 24 support", but the launcher does not refuse. |
| KGP 1.9.25 | `java.lang.IllegalArgumentException: 25` at `org.jetbrains.kotlin.com.intellij.util.lang.JavaVersion.parse`, reached from `JavaVersion.current()` → `isAtLeastJava9()` inside `KotlinCoreEnvironment`. |
| AGP 8.11.0, on the real generated project | `BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 69` — 69 is Java 25's class-file version. This is `gen/android/gradlew :app:tasks`, so it is the actual build failing and not a proxy. |

**A Gradle toolchain does not fix it**, and that is worth writing down because it is the first
thing anyone will reach for: the failure is in the **buildscript classpath**, which runs in the
Gradle daemon's JVM. Only `JAVA_HOME` or `org.gradle.java.home` changes that, and both need a
JDK ≤ 24 on disk.

**The fix is a second JDK, and it is Markus's call.** Two shapes, neither taken:

- `winget install EclipseAdoptium.Temurin.21.JDK` — machine-wide, adds a `PATH` entry.
- The Temurin 21 **.zip** unpacked into `~/.jdks`, with `$env:JAVA_HOME` set per-shell or
  `org.gradle.java.home` in `gen/android/gradle.properties`. No installer, no `PATH` change, no
  registry; reversible by deleting a folder. **This is the narrower one.**

Either way JDK 25 stays the machine default and nothing else on it changes.

## 3. What is gated, and the two reasons are different

The plan named three compile breaks. The build found **three errors**, and one of them is not
on that list — which is the correction worth keeping.

### Cannot compile

| Site | Why |
| --- | --- |
| `tauri_plugin_single_instance::init` (`lib.rs`) | The crate is **empty** on Android: its `lib.rs` opens with `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, so `init` is an unresolved name rather than a no-op. |
| `window.rs` (whole module) | `open_sized_to_monitor` calls `WebviewWindow::center()`, which tauri declares `#[cfg(desktop)]`. |
| `focus_existing_window` (`lib.rs`) | `WebviewWindow::unminimize()` is `#[cfg(desktop)]` too. **The plan predicted the `--await-predecessor` block here and was wrong** — that block compiles fine on Android. |

### Must not run (compiles everywhere)

| Site | Why |
| --- | --- |
| The `--await-predecessor` handshake | There is no portable exe on a phone, and `current_exe()` names a native-library directory. |
| The mirror's `install_hook` + `spawn` | The mirror's point is a folder a reader greps or syncs; Android's app directory is not that, and `tauri-plugin-dialog` has no folder picker there. |
| `update::clean_up` and the daily update check | Nothing stages a build beside the executable, and the store is what notices a release. |
| `tauri_plugin_snap_layout` | No caption to park an overlay over. The crate itself compiles everywhere. |

**`mirror/`, `transfer/` and `update.rs` still compile on Android, and that is not a violation
of the spec's ⛔.** `AppState` carries `mirror::watch::{Mask, LastPass}` and six sites construct
them; `update.rs` owns `get_app_meta`/`set_app_meta`, which a dozen modules call. The mark is
about **behaviour**, and in a crate whose every `pub fn` in a `pub mod` is public API — so
nothing raises `dead_code` — not *running* the code costs nothing and not *compiling* it costs a
six-file ripple. What is gated is the hook, the thread and the two update tasks, which is the
whole of what makes any of it do anything.

`tauri_build::build()` emits `cfg(desktop)` and `cfg(mobile)`, so every gate above is a real cfg
and cargo checks it.

## 4. The `content://` seam

**A file the reader picks on Android is not a path.** `tauri-plugin-dialog`'s
`DialogPlugin.kt` fires `ACTION_OPEN_DOCUMENT`/`ACTION_CREATE_DOCUMENT` and returns
`uri.toString()` — a row in a ContentProvider. `std::fs::read` of one answers `No such file or
directory`, which reads exactly like the reader picked a file that vanished. All three of
`import_read_file`, `export_write_file` and `deck_set_cover_image` did that.

`src-tauri/src/picked.rs` is the one place that knows the difference.
`tauri_plugin_fs::Fs::open` takes a `FilePath::Url`, asks the Kotlin side for a descriptor
through the ContentResolver, and builds a **`std::fs::File`** from the raw fd — so everything
downstream is unchanged.

Three things the implementation had to get right that a sketch would not:

- **`open_read` answers a concrete `std::fs::File`, not a boxed `Read`.**
  `image::ImageReader` requires `Seek`, and `encode_cover` reopens its source for the two-pass
  pixel bound. A `Box<dyn Read + Send>` would have broken deck covers outright.
- **No `url` dependency.** `FilePath` implements `FromStr` with `Err = Infallible` and already
  makes the path-or-URL decision — a scheme longer than one character is a URL, and a
  one-character scheme is a Windows drive letter.
- **The import bound moved from `metadata()` into the read.** A `content://` URI has no size to
  stat, so `take(MAX + 1)` and a length test is the fence. A 200 MB mistake still costs one
  megabyte rather than two hundred; what is lost is that the refusal can no longer quote the
  file's real size.

**No `fs:` permission is granted, on any platform, and that is correct rather than an
oversight.** Tauri's ACL gates commands the **webview** invokes; `Fs::open` is a Rust-side
method on managed state and no `invoke` crosses the boundary. The page's filesystem access is
unchanged: none. `the_mobile_capability_drops_every_verb_the_platform_has_no_answer_for` asserts
it. This is the app's standing habit — a dialog verb answers a name, and a name is not
permission — and the answer to the next file need is another twelve-line command, never a wider
capability.

## 5. The capability split, and the proof that `platforms` is load-bearing

`capabilities/default.json` became `desktop.json` + `mobile.json`. `desktop.json` is the
shipped permission set unchanged, plus `"platforms": ["windows", "linux", "macOS"]`.
`mobile.json` drops:

| Dropped | Why |
| --- | --- |
| the four `core:window:` verbs | Three — `minimize`, `toggle_maximize`, `start_dragging` — are `#[cfg(desktop)]` in tauri and are not commands there at all. The fourth would close the app from a button no phone user is looking for. |
| both `snap-layout:` verbs | No caption. |
| the three `mcp-bridge:` verbs | An unauthenticated WebSocket that evaluates arbitrary JavaScript, on a device that joins other people's networks. |
| `opener:default` → `allow-open-url` + `allow-default-urls` | The third verb in that set reveals an item in a directory, which the plugin's own manifest says Android does not support. |

**`platforms` filters before permission resolution, proven rather than assumed.** A nonexistent
permission planted in `desktop.json` fails the Windows build with
`Permission opener:allow-a-verb-that-does-not-exist not found` and is **invisible** to the
`aarch64-linux-android` build, which exits 0. Both files are still embedded in both binaries —
the field is what decides which one applies, not which one ships.

## 6. Config, and a trap the config test alone does not catch

`tauri.conf.json` gains `bundle.android`:

```json
"android": { "minSdkVersion": 26, "debugApplicationIdSuffix": ".debug" }
```

**26 rather than the config default 24**: API 26 is where the system WebView became
independently updatable through Play on every device, and the WebView is what renders a React 19
bundle. `.debug` keeps a dev install from taking a release install's data directory, which on a
phone means the corpus is rebuilt.

**`bundle.android` is read at *generation* time and baked into
`gen/android/app/build.gradle.kts`.** `gen/android/` is committed and `android init` is not
re-run, so editing `tauri.conf.json` alone changes nothing about the APK — silently, with a test
that reads the config still green. Verified by mutation: with the Gradle at 24 and the config at
26, the config assertion passes and only
`the_generated_gradle_carries_the_floor_the_config_asked_for` goes red. **Changing either field
means re-running `npx tauri android init` and reviewing the diff.** Read that diff
carefully rather than accepting it: the manifest below now carries a hand-edit
(`android:allowBackup="false"`) that a re-init reverts, and it is the only file in
`gen/android/` that does.

`versionCode` is left unset; Tauri derives it as `major*1000000 + minor*1000 + patch`.

**The generated manifest asks for `android.permission.INTERNET` and nothing else** — no storage
permission (the document picker grants access per URI), no location, no camera. Pinned by a
test, because a permission here is a permission a Play listing has to justify. The template also
adds Android TV support (`LEANBACK_LAUNCHER`, `android.software.leanback` non-required) and a
`FileProvider`; neither is a permission and both were left.

`usesCleartextTraffic` is a manifest placeholder: `false` in `defaultConfig`, **`true` in the
debug build type**, which is what lets `adb reverse` serve the dev server over
`http://localhost:1420`.

**`android:allowBackup="false"` is the one hand-edit the manifest carries, and it is a privacy
decision before it is a quota one.** The template leaves the attribute unset, which defaults to
**true**: Android Auto Backup would copy the app's data directory — the collection, the decks,
what each card cost — into the reader's Google Drive without them choosing it, and this app's
design is that no server holds anything it can read. The ~500 MB corpus against Auto Backup's
25 MB quota is the second reason and the weaker one, because it is repaired by excluding the
corpus and backing up the user tables — the same privacy failure with a smaller payload. That
ordering is written into the manifest's own comment for the same reason it is written here.

`the_android_application_refuses_auto_backup` pins it, and it reads the value out of the
`<application>` open tag rather than searching the file: the comment above the element quotes
`android:allowBackup="false"` verbatim, so a substring test could not tell the attribute's
absence from its presence. Both mutations were run — deleting the attribute and flipping it to
`"true"` — and both go red. It is also the first thing in this file that a re-run of
`npx tauri android init` would silently drop, which is what makes the test worth more than the
attribute.

## 7. Driving the phone

**`adb` is not on Git Bash's `PATH`.** It is at
`C:\Users\Markus\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`
(1.0.41, platform-tools 37.0.1). A second copy now exists under `C:\Android\Sdk\platform-tools`.

**Use `adb reverse`, never `TAURI_DEV_HOST`.** `tauri.conf.json`'s `devCsp` names
`ws://localhost:1420 http://localhost:1420` literally, so a LAN host would be refused by the
page's own CSP — and the symptom is a blank window with a console error nobody is watching, not
a build failure. `tauri android dev` runs `adb reverse` itself.

**There is no console on a phone; logcat is it.** `adb logcat -s RustStdoutStderr:*` is where
this crate's `eprintln!` goes, which is how `init_state`'s data-directory message and the sync's
failures become visible at all.

`scripts/android-devtools.ps1` forwards the app's WebView DevTools socket to **port 9444** —
9222 is the desktop app's and 9223 is the MCP bridge's, both hardcoded in tracked files.
`scripts/cdp.mjs` already reads `CDP_PORT` (`scripts/cdp.mjs:32`), so the desktop harness drives
the phone unchanged.

**What was verified on the device, on 2026-08-28, against another app's WebView:**

- `/proc/net/unix` **is** readable by the `shell` user on Android 16 — 1342 lines.
- The socket really is named `webview_devtools_remote_<pid>`.
- `adb forward tcp:9444 localabstract:webview_devtools_remote_15849` took, and
  `http://127.0.0.1:9444/json/version` answered **200** with a `webSocketDebuggerUrl`.
- **The device carries two `@stetho_*_devtools_remote` sockets**, which is why the script picks
  by pid rather than taking the first match — a first-match script would have forwarded a
  text-messaging app's debugger and reported success.
- `/json/list` showed **two `type: page` targets**, so `cdp.mjs` taking the first one is a real
  hazard here. Put `location.href` in the first payload of every pass.

## 8. Device facts

Measured with `adb` on 2026-08-28. These are facts about the phone, not about this app.

| | |
| --- | --- |
| Model | OnePlus **CPH2581** (`OP595DL1`), `arm64-v8a` |
| Android | **16**, SDK **36** |
| System WebView | `com.google.android.webview` **150.0.7871.183** (V8 15.0.245.21) |
| WebView user agent | `Mozilla/5.0 (Linux; Android 16; CPH2581 Build/BP2A.250605.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.183 Mobile Safari/537.36` |

That user agent is the fixture in `src/lib/platform.test.ts`, `AppShell.test.tsx` and
`SettingsPage.test.tsx` — read off the device rather than invented, which is why it carries the
`Build/…` segment and the `; wv` marker.

**No performance number exists.** First sync, FTS5, the facet warm-up, the collapsed browse, the
`-wal` size and the APK footprint are all unmeasured, because no APK has been built.

## 9. The frontend's half

`src/lib/platform.ts` is the only place the page asks what platform it is on, and it asks the
**user agent** — `src/lib/images.ts`'s `imageOrigin()` is the shipped precedent. It answers
`false` for anything it does not recognise, which is what keeps jsdom and Storybook on the
desktop shape without either of them having to say so. The token is `Android` and not `Linux` or
`Mobile`, because an Android agent is a Linux one with one extra word.

Two readers: `AppShell` (no caption) and `SettingsPage` (no Backup panel). **A third reader is a
reason to re-open whether this belongs behind the core boundary instead**, where `ipc.ts`
already knows which core it is talking to — the web target makes "is this Android" and "is this
the Android app" different questions.

`InstallKind::Managed` is the fourth install kind and Android's. **Not `Other`**, which means
"we could not tell, here is the release page" — and this repo's release page offers a Windows
exe and an NSIS installer, which is a worse answer on a phone than none. `install_kind_for` asks
the platform question **before** touching the disk, so `detect_install_kind`'s write probe is
never attempted in a native-library directory. `UpdatePanel` branches on `installKind` rather
than on `isAndroid()`, because the backend has already answered and two independent answers to
one question are free to disagree.

## 10. What is still open

| Open | Where it goes |
| --- | --- |
| **The JDK**, and therefore the APK, the device run and every number | §2 — Markus's call |
| **Does the MCP bridge open a socket on the phone?** It is registered under `#[cfg(debug_assertions)]` and `tauri android dev` is a debug build. `capabilities/mobile.json` denies its three commands, but the **socket** is opened in Rust, where the ACL is not in the path. It binds `127.0.0.1`, so the exposure is the phone's own loopback rather than the network — reachable by any other app on the device. **If it listens, it needs a `#[cfg(desktop)]` on the registration.** | unverified; needs the APK |
| **Does `RunEvent::Exit` ever fire?** `checkpoint_on_exit` folds the WAL back on the way out, and `tauri::RunEvent` has no `Paused` or `Suspended` variant — a phone kills processes rather than exiting them. `db.rs` sets `journal_size_limit` to 64 MB, so the designed floor is 64 MB of `-wal`, not the 857 MB an unbounded ingest journal would leave. A `-wal` larger than 64 MB would be a finding. | unverified; needs the APK |
| The three pickers against a real ContentResolver | needs the APK — this is the one seam whose Rust has never touched the thing it is written against |
| **16 KB page sizes.** NDK r27 supports them behind a linker flag; r28 makes them the default. Play requires 16 KB support for apps targeting Android 15+. Not blocking here, but it is a Play-release question. | with the release story |
| The Play release — a developer account, an upload keystore, a `signingConfig`, whether `release.yml` learns to build an AAB, and a privacy policy | none of it an agent's work |
| Mobile layout, touch drag-and-drop | other PRs |
