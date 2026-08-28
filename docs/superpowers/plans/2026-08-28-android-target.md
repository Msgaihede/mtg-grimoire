# The Android Target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MTG Grimoire runs on a physical Android phone, built from this repo's existing Rust core and existing React frontend, with the corpus, search, faceting, decks, collection and the optional feeds all working — and with the four desktop-only mechanisms (the plain-text mirror, the portable exe swap, the custom window chrome, Snap Layouts) deliberately unreachable rather than broken.

**Architecture:** Android is **native**. Tauri's mobile target compiles this same crate for `aarch64-linux-android` and runs `dist/` in the system WebView. It gets `rusqlite` with `bundled`, a real filesystem, `tokio`, threads and WAL — the whole wasm story (OPFS, no WAL, one connection, the push parser) is **Web's and only Web's**. So the work is not a port. It is: a toolchain, a `cfg(desktop)` / `cfg(mobile)` split at four named places, a second capability file, one genuinely new seam (a picked file on Android is a `content://` URI, not a path), and a verification harness.

**Tech Stack:** Rust 2021, Tauri 2.11.5, `@tauri-apps/cli` 2.11.4 (npm — **not** a `cargo tauri` subcommand; see Task 1), Android Gradle Plugin 8.11.0, Gradle 8.14.3, Kotlin Gradle Plugin 1.9.25, `compileSdk`/`targetSdk` 36. No new npm dependencies. One new Rust dependency, Android-only: `tauri-plugin-fs`, already in `Cargo.lock` transitively.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §1, §6.3, §9, §10 (PR 8) · [the parity matrix](../specs/2026-08-27-cross-platform-parity-matrix.md), the Android column · [the wasm-core spike](../research/2026-08-27-wasm-core-spike.md), the device section.

---

## What was verified before this plan was written, and what it changes

Every claim below was read out of this repo, out of the vendored crate sources under
`~/.cargo/registry/src/`, or off this machine on **2026-08-27/28**. Six of them contradict a
reasonable reading of the spec or the brief, which is why they are at the top rather than buried
in a step.

**1. `tauri-plugin-single-instance` does not exist on Android.** Its `src/lib.rs` opens with
`#![cfg(not(any(target_os = "android", target_os = "ios")))]` — the whole crate compiles to
nothing. `lib.rs`'s `.plugin(tauri_plugin_single_instance::init(…))` is therefore a **hard compile
error** for `aarch64-linux-android`, not a runtime no-op. Task 2.

**2. `Window::center()` is `#[cfg(desktop)]` in tauri 2.11.5** (`tauri/src/window/mod.rs:1924`).
`window::open_sized_to_monitor` calls it, so `window.rs` is a **second hard compile error**.
Task 2.

**3. Three of `src/lib/window.ts`'s four verbs do not exist on mobile.** In
`tauri/src/window/plugin.rs`, `minimize`, `toggle_maximize` and `start_dragging` are all
`#[cfg(desktop)]`; only `close` is in the shared handler. `TitleBar` on a phone would be three
dead buttons and one that kills the app. Tasks 4 and 6.

**4. A file the reader picks on Android is a `content://` URI, not a path.** The dialog plugin's
`DialogPlugin.kt` fires `ACTION_OPEN_DOCUMENT`/`ACTION_CREATE_DOCUMENT` and returns
`uri.toString()`. `import_read_file`, `export_write_file` and `deck_set_cover_image` all take a
`String` path and hand it to `std::fs`, so all three fail on Android with "No such file or
directory". This is the one genuinely new mechanism in this PR, and the parity matrix's
"Tauri mobile dialog" cell does not mention it. Task 5.

**5. `src-tauri/src/mirror/` and `src-tauri/src/transfer/` cannot be `cfg`'d out, and do not need
to be.** `AppState` carries `mirror: Arc<mirror::watch::Mask>` and
`mirror_status: Mutex<mirror::watch::LastPass>`, and those two types are constructed in
`sync.rs`, `index/mod.rs`, `search.rs` and `marketplace_feed.rs` — six sites including test
fixtures. `update.rs` is worse: it holds `get_app_meta`/`set_app_meta`, which `card.rs`,
`deck.rs`, `flatten.rs` and a dozen others call. **Spec §6.3's ⛔ is a statement about
*behaviour*, and the cheap way to deliver it is to not *run* the code rather than to not
*compile* it.** This crate is a `rlib`/`cdylib`/`staticlib` library, so a `pub fn` in a `pub mod`
is public API and raises no `dead_code` warning when nothing calls it — the `-D warnings` cost of
leaving them compiled is zero. The mirror's **hook and thread** are gated, the mirror's Backup
panel is hidden, the updater answers a new `InstallKind`, and the modules stay. Tasks 2, 6, 7.

**6. JDK 25 is on this machine and is almost certainly the wrong JDK.** `JAVA_HOME` is
`C:\Program Files\OpenJDK\jdk-25`; the `java` on `PATH` is `C:\Program Files\Eclipse
Adoptium\jre-21.0.8.9-hotspot` — **a JRE, which cannot compile Java and cannot back a Gradle
toolchain**. Strings pulled out of `node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node`
show the template pins **Gradle 8.14.3** and **Kotlin Gradle Plugin 1.9.25**; Gradle 8.14 tops out
at Java 24 and KGP 1.9.x at Java 21. So the expected failure is a Gradle "Unsupported class file
major version" or "Could not determine java version from '25'". **Task 1 tests this rather than
assuming it, and stops.**

**Also verified, and load-bearing in the smaller way:**

- `run()` in `lib.rs` **already carries** `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. The
  entry point is done.
- `vite.config.ts` **already honours** `TAURI_DEV_HOST` with the `hmr` block Tauri mobile wants.
- `src/lib/images.ts`'s `imageOrigin()` **already returns** `http://mtgimg.localhost` for a user
  agent containing `Android`. The custom protocol's origin is right today.
- `tauri.conf.json`'s **`devCsp` names `ws://localhost:1420 http://localhost:1420` literally**.
  That is why this plan uses `adb reverse` and **never** `TAURI_DEV_HOST` with a LAN IP: a LAN
  host would be refused by the page's own CSP, and the symptom is a blank window with a console
  error, not a build failure.
- TLS is `rustls` over **`ring`** with **`webpki-roots`** (checked in `Cargo.lock`), not
  `aws-lc-rs` and not a platform verifier — so HTTPS on Android needs no cert plumbing and no
  cmake.
- `db.rs` sets `journal_size_limit` to 64 MB, so a process Android kills without an `Exit` event
  leaves at most 64 MB of `-wal`, not the 857 MB an unbounded ingest journal would.
- `tauri_build::build()` emits `cfg(desktop)` and `cfg(mobile)` (`tauri-build/src/lib.rs:476`), so
  every gate in this plan is a real cfg and `cargo` will check it.
- `tauri-plugin-snap-layout` ships a `#[cfg(not(windows))]` dummy that still registers both
  commands, so its ACL entries resolve on Android. It is left in the dependency graph untouched.
- The Android platform-support levels in the vendored manifests: **dialog "partial — Does not
  support folder picker"**, **clipboard-manager "partial — Only plain-text content support"**,
  **opener "partial — Only allows to open URLs via `open`"**. The app uses only `writeText` and
  only `openUrl`, so two of those three cost nothing. The folder picker is the mirror's, and the
  mirror is desktop-only.

## What this PR does not do

- **No mobile layout.** That is PR 9, after `frontend-design` options are approved. This PR makes
  the app *run*; it will look like a desktop app on a phone, and that is the expected outcome.
- **No touch drag-and-drop.** That arrives with `@dnd-kit/react` in PR 3, which is Phase 1.
- **No Play Store release.** Task 7 writes the in-app answer ("updates come from Play") and stops
  at the point where a Google Play developer account, a signing key and a publish are needed —
  none of which an agent creates. See its stop gate.
- **No CI job for Android.** Task 3 keeps `changes` routing honest so `gen/android/` does not
  silently vacuum a Kotlin edit into the Rust matrix, but building an APK in CI needs an SDK
  install on the runner and is out of scope.

## Global Constraints

Copied from the spec and the repo's `CLAUDE.md`; every task's requirements implicitly include
these.

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; CI does, and
  those are the only reds a fully green verify can produce. Run both in `src-tauri/` too.
- **`cargo clippy --locked` and `cargo test --locked` are what CI runs.** Any `Cargo.toml` edit
  that moves `Cargo.lock` must commit the lock in the same commit or CI goes red with
  `the lock file needs to be updated`.
- **The `rust` CI matrix includes `ubuntu-22.04`.** Every `cfg` written here must leave the crate
  compiling on Linux as well as Windows — `#[cfg(desktop)]` covers both, `#[cfg(windows)]` does
  not.
- **Never install `@types/node`.** `xlsx` is banned. TypeScript stays on 6.0.x.
- **Adding a dependency with permissions means adding its narrowest permission, never its
  `:default`.** This PR adds `tauri-plugin-fs` and grants it **nothing** — see Task 5 for why
  that is correct and not an oversight.
- `clippy` caps function arguments at 7.
- **Never hand-write rows into `cards` or `sync_meta`.**
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.
- **`data/` is the user's and is never committed.**
- **`adb` is not on Git Bash's `PATH`.** It lives at
  `C:\Users\Markus\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`
  (platform-tools 37.0.1). Every step below spells it out or sets `$ADB` first.
- **A `tauri android dev` run takes the `app` lock**, exactly like `tauri dev`: it starts Vite on
  1420 and builds the crate. Claim it through
  `.claude/skills/running-the-app/lock.ps1` before any device task, and release it after.
- **Every Android figure taken on the OnePlus 12 (`CPH2581`, Snapdragon 8 Gen 3, Android 16 /
  SDK 36) is an optimistic bound and must be labelled as one.** It is a flagship. Name the build
  (debug or release) in every number.

---

### Task 1: The toolchain — establish it, cost it, and stop

**This task installs software and cannot be mutation-tested.** What replaces a mutation is an
explicit falsifier at each step: a named command whose output would prove the step did not do
what it claims. Read them; a step that "succeeded" with no evidence has not succeeded.

**This task ends in a stop-and-report gate. Do not start Task 2 until Markus has answered it.**

**Files:** none in the repo. Nothing is committed by this task except the report in Step 8.

**What is on this machine right now** (measured 2026-08-27, and the "before" this task is
measured against):

| | |
| --- | --- |
| Rust targets installed | `wasm32-unknown-unknown`, `x86_64-pc-windows-msvc` — **no Android targets** |
| rustc / cargo | 1.96.0 |
| Android SDK / NDK / cmdline-tools / Gradle | **none**; `ANDROID_HOME`, `NDK_HOME`, `ANDROID_NDK_ROOT` all empty; no `%LOCALAPPDATA%\Android`, no `%USERPROFILE%\.gradle` |
| `adb` | 1.0.41, platform-tools **37.0.1**, at the WinGet path above |
| JDK | `JAVA_HOME=C:\Program Files\OpenJDK\jdk-25`; `java` on PATH is Adoptium **jre**-21.0.8.9 — **a JRE, not a JDK** |
| Tauri CLI | **npm** `@tauri-apps/cli` → `npx tauri --version` prints `tauri-cli 2.11.4`. **`cargo tauri` is not installed** (`error: no such command: tauri`) |
| clang | 22.1.8 at `C:\Program Files\LLVM\bin\clang.exe`, **not on `PATH`** |
| Free disk | C: 174.3 GB · D: 626.0 GB |

- [ ] **Step 1: Record the before state, so the cost is a measurement and not a guess**

```powershell
rustup target list --installed
"JAVA_HOME=$env:JAVA_HOME"; "ANDROID_HOME=$env:ANDROID_HOME"; "NDK_HOME=$env:NDK_HOME"
Get-PSDrive C | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
```

Write the three outputs into the scratchpad as `android-toolchain-before.txt`. Step 7 diffs
against it.

**Falsifier:** if `rustup target list --installed` already names `aarch64-linux-android`, this
machine is not in the state this plan was written against — stop and say so, because every disk
figure below will be wrong.

- [ ] **Step 2: Install a JDK that Gradle 8.14.3 and Kotlin 1.9.25 accept**

The two version pins were read out of the CLI binary itself:

```powershell
$bin = "D:\Code\mtg-grimoire\node_modules\@tauri-apps\cli-win32-x64-msvc\cli.win32-x64-msvc.node"
$txt = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($bin))
foreach ($p in @("com\.android\.tools\.build:gradle:[0-9.]+","gradle-[0-9.]+-bin",
                 "org\.jetbrains\.kotlin:kotlin-gradle-plugin:[0-9.]+",
                 "compileSdk = [0-9]+","targetSdk = [0-9]+","minSdk = [0-9]+")) {
  [regex]::Matches($txt,$p) | ForEach-Object { $_.Value } | Select-Object -Unique
}
```

Expected (verified 2026-08-27): `com.android.tools.build:gradle:8.11.0`, `gradle-8.14.3-bin`,
`org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25`, `compileSdk = 36`, `targetSdk = 36`,
`minSdk = 21`.

**Run this before deciding anything** — if the CLI has moved and now pins a Gradle 9.x, the JDK
question below may already be answered and installing a second JDK would be waste.

Then install **Temurin JDK 21** (a JDK, not the JRE already present):

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK --accept-package-agreements --accept-source-agreements
```

Do **not** overwrite the machine-wide `JAVA_HOME`. Set it per-shell for the Android work:

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot"   # confirm the real folder name
& "$env:JAVA_HOME\bin\javac.exe" -version    # must print a javac version, not "not recognized"
```

**Falsifier:** `javac -version` failing, or printing 25, means `JAVA_HOME` is still the JDK 25 or
the JRE. A JRE has no `bin\javac.exe` at all — that is the one-command test for the trap this
machine is already in.

- [ ] **Step 3: Install the Android SDK command-line tools, platform 36, build-tools and the NDK**

```powershell
winget install --id Google.AndroidStudio --accept-package-agreements --accept-source-agreements
```

*or*, if a full Android Studio is unwanted, the command-line tools alone from
`https://developer.android.com/studio#command-line-tools-only`, unpacked to
`C:\Android\Sdk\cmdline-tools\latest`. **Which of the two is used is one of the questions in the
stop gate below** — Studio is the larger install and the one that manages the SDK for you.

Then:

```powershell
$env:ANDROID_HOME = "C:\Android\Sdk"          # or %LOCALAPPDATA%\Android\Sdk if Studio installed it
$sdk = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"
& $sdk --licenses            # licence acceptance is interactive; this is a human step
& $sdk "platforms;android-36" "build-tools;36.0.0" "platform-tools" "ndk;27.2.12479018"
$env:NDK_HOME = (Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory | Select-Object -Last 1).FullName
"ANDROID_HOME=$env:ANDROID_HOME"; "NDK_HOME=$env:NDK_HOME"
```

`ANDROID_HOME` and `NDK_HOME` are the two variable **names the Tauri CLI actually reads** —
both appear as literal strings in `cli.win32-x64-msvc.node`. `ANDROID_NDK_ROOT` does not, so
setting only that one is a silent no-op.

**The NDK revision is not pinned by anything in this repo and is not knowable in advance.** r27
is the current LTS at time of writing; if `sdkmanager --list` offers something else, take the
newest r27.x or r28.x and **record which**, because the next person's build reproduces only if
they know.

**Falsifier:** `& $sdk --list_installed` must name `ndk;<rev>` and `platforms;android-36`. If
either is missing the later `cargo build` will fail with a `cc` error about a missing
`aarch64-linux-android*-clang`, which reads like a Rust problem and is not one.

**Licence acceptance is a decision, not a step an agent takes silently.** If `--licenses` asks
anything, stop and report it.

- [ ] **Step 4: Install the Rust Android targets**

Tauri's `android init` wants all four by default. Install all four; Task 3 decides whether to
narrow the dev loop to `aarch64` alone.

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
rustup target list --installed
```

**Falsifier:** the second command must now list six targets (the two that were there plus four).
Six, not "no error" — `rustup target add` exits 0 for a target it did not install.

- [ ] **Step 5: Prove the hardest compile before anything else depends on it**

The riskiest single thing in this whole PR is `rusqlite`'s `bundled` feature: it compiles
SQLite's C amalgamation with the `cc` crate against the NDK's clang. If that does not work,
nothing else matters.

```powershell
Set-Location D:\Code\mtg-grimoire\.claude\worktrees\spike-wasm-core\src-tauri
cargo build --target aarch64-linux-android --lib 2>&1 | Tee-Object -FilePath "$env:TEMP\android-first-build.log"
```

This will **fail** — that is expected, and the failures are the subject of Task 2. What this step
is looking for is *which* failures. Grep the log:

```powershell
Select-String -Path "$env:TEMP\android-first-build.log" -Pattern "libsqlite3-sys|error: linker|cc failed|error\[E" |
  Select-Object -First 40
```

**The pass condition is that `libsqlite3-sys` and `ring` both build.** If they do, the C
toolchain is wired correctly and the remaining errors are this crate's own — which is exactly
what Task 2 fixes. If `libsqlite3-sys` fails, the NDK is not reachable and Task 2 cannot start.

**Falsifier:** `cargo build` succeeding outright would mean the three compile breaks named at the
top of this document do not exist, and this plan is wrong about its own premise. Report that
rather than proceeding — it would mean the crate sources changed under the plan.

- [ ] **Step 6: Confirm the device and its debugging socket**

```powershell
$ADB = "C:\Users\Markus\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe"
& $ADB devices -l
& $ADB shell getprop ro.build.version.sdk
& $ADB shell getprop ro.product.cpu.abi
```

Expected: one device, `sdk` 36, abi `arm64-v8a`. USB debugging must be enabled on the phone and
the RSA fingerprint accepted — both are taps on the device, not commands.

**Falsifier:** `List of devices attached` with nothing under it (which is what this machine
printed on 2026-08-27, with the phone unplugged). An empty list is not "adb is broken".

- [ ] **Step 7: Measure what it cost**

```powershell
Get-PSDrive C | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
foreach ($d in @("$env:ANDROID_HOME","$env:USERPROFILE\.gradle","$env:USERPROFILE\.rustup\toolchains")) {
  "{0,-60} {1,8:N1} GB" -f $d, ((Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object Length -Sum).Sum / 1GB)
}
```

- [ ] **Step 8: STOP AND REPORT**

Do not proceed. Write a report naming, with numbers:

1. **The JDK answer.** Did JDK 25 work, or did Gradle refuse it? Which JDK is now used, where it
   lives, and whether `JAVA_HOME` was changed machine-wide or per-shell. *(Prediction on the
   evidence above: it refuses, and Temurin JDK 21 is needed. If it worked, say so plainly — a
   wrong prediction confirmed by measurement is the point of this step.)*
2. **What was installed and what it cost** — Studio or cmdline-tools, which NDK revision, which
   platform and build-tools, and the disk delta from Step 1.
3. **Whether any licence or account was required**, and whether anything was accepted on
   Markus's behalf. It should not have been.
4. **The result of Step 5's build** — did `libsqlite3-sys` compile against the NDK? Paste the
   first five distinct errors that are *this crate's*.
5. **Anything that needed a decision.** A JDK downgrade, a >10 GB install, a licence, a second
   SDK location — every one of those is Markus's call, not the agent's.

No commit. This task changes no tracked file.

---

### Task 2: The crate compiles for `aarch64-linux-android`

**Files:**
- Modify: `src-tauri/src/lib.rs` — the plugin chain, the `setup` body, `init_state`, the module list
- Modify: `src-tauri/src/paths.rs` — a mobile branch for the data directory
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/paths.rs`

**Interfaces:**
- Consumes: Task 1's toolchain.
- Produces: `cargo build --target aarch64-linux-android --lib` succeeding, and
  `cargo clippy --all-targets --locked -- -D warnings` still clean on Windows and Linux.

> **What is gated and what is not.** Three things are gated because they **cannot compile**:
> single-instance, `window.rs`, and the launch-argument handling that reads `current_exe`. Two
> things are gated because they **must not run**: the mirror's update hook and its thread. Four
> modules named ⛔ for Android in spec §6.3 — `mirror/`, `transfer/`, `update.rs`, and the
> `window.rs` *commands* — are treated differently from one another on purpose, and finding 5 at
> the top of this document is the reasoning. Do not "finish the job" by `cfg`-ing out `mirror/`
> or `update.rs`: `AppState` and a dozen `app_meta` callers depend on them, and the result is a
> six-file ripple that buys a few kilobytes.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/paths.rs`'s test module. This is the one piece of Task 2 that has behaviour
worth pinning rather than merely compiling:

```rust
    /// Android has no portable location. `current_exe()` there points into the app's own
    /// native-library directory or `/system/bin`, and `resolve_data_dir` would probe
    /// `<that>/data` — creating a directory under a read-only mount, or beside the extracted
    /// `.so` files where the OS is free to wipe it on the next install. The per-user directory
    /// Tauri resolves is the only correct answer, and `data_dir_for` is what refuses to ask
    /// the question on that platform.
    #[test]
    fn a_mobile_build_never_probes_beside_the_executable() {
        let tmp = std::env::temp_dir().join("mtgtest-paths-mobile");
        let _ = std::fs::remove_dir_all(&tmp);
        let exe = tmp.join("exe");
        let app = tmp.join("app");
        std::fs::create_dir_all(&exe).unwrap();

        // `exe` is writable, so `resolve_data_dir` WOULD take it. `data_dir_for` must not,
        // when told it is a mobile build.
        let mobile = data_dir_for(Some(exe.as_path()), &app, false);
        let desktop = data_dir_for(Some(exe.as_path()), &app, true);

        let probe_left_behind = exe.join("data").exists();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(mobile, app.join("data"));
        assert_eq!(desktop, exe.join("data"));
        assert!(
            !probe_left_behind,
            "the mobile branch must not create <exe dir>/data at all"
        );
    }

    /// No executable path at all is still the per-user directory, on either platform. This is
    /// the arm `init_state` already had and it must survive the split.
    #[test]
    fn no_executable_path_is_the_per_user_directory_on_both() {
        let tmp = std::env::temp_dir().join("mtgtest-paths-noexe");
        let _ = std::fs::remove_dir_all(&tmp);
        let app = tmp.join("app");

        let mobile = data_dir_for(None, &app, false);
        let desktop = data_dir_for(None, &app, true);

        let created = app.join("data").is_dir();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(mobile, app.join("data"));
        assert_eq!(desktop, app.join("data"));
        assert!(created, "the fallback directory is created, not just named");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test paths:: 2>&1 | tail -12`
Expected: **compile failure**, `cannot find function 'data_dir_for' in this scope`. That is the
red. A `test result: ok. 0 passed` here would mean the filter matched nothing — check the number,
not the word.

- [ ] **Step 3: Add `data_dir_for` to `paths.rs`**

Above the existing `resolve_data_dir`, and leaving that function exactly as it is (three tests
pin it):

```rust
/// Which directory this build stores its database in, given what the process knows about
/// itself.
///
/// `desktop` is `cfg!(desktop)` at the one call site. It is a parameter rather than a `cfg`
/// inside the body so that **both** branches are compiled and tested on every platform — a
/// `#[cfg(mobile)]` body would be a rule nothing on this machine ever runs, and the Android
/// build is the one place a mistake in it would surface.
///
/// The portable-beside-the-exe question is a **desktop** question. On Android
/// `std::env::current_exe()` answers something inside the app's own native-library directory
/// or under `/system/bin`, neither of which is a place to put 500 MB of card corpus: the first
/// is replaced wholesale on the next install and the second is a read-only mount. Probing it
/// is not merely useless, it leaves an empty `data/` behind on the paths where the probe half
/// succeeds — which is exactly the failure `dir_writable`'s cleanup exists to prevent on
/// desktop.
pub fn data_dir_for(exe_dir: Option<&Path>, appdata_dir: &Path, desktop: bool) -> PathBuf {
    match exe_dir {
        Some(dir) if desktop => resolve_data_dir(dir, appdata_dir),
        // No executable path (an unusual host, a deleted binary), or a mobile build: the
        // portable location cannot be named or must not be used, so go straight to the
        // per-user folder.
        _ => {
            let fallback = appdata_dir.join("data");
            let _ = fs::create_dir_all(&fallback);
            fallback
        }
    }
}
```

- [ ] **Step 4: Call it from `init_state`**

In `src-tauri/src/lib.rs`, replace the `let data_dir = match &exe_dir { … }` block with:

```rust
    let data_dir = paths::data_dir_for(exe_dir.as_deref(), &app_data, cfg!(desktop));
```

`portable` and `fallback` above it stay — `data_dir_error` still names both in its message, and
on Android `portable` is simply a name that never becomes the answer.

- [ ] **Step 5: Split the plugin chain so the order is preserved**

In `run()`, replace the head of the builder chain. **The order matters and the existing comment
says why**: single-instance decides whether the process lives at all, and it must stay first.
Two `let` bindings rather than one `#[cfg]` inside the chain, because an attribute on a
mid-chain method call is not valid Rust — which is the same reason the MCP bridge is already
bound separately.

```rust
    // Desktop only, and first, before every other plugin: this one has to decide whether the
    // process lives at all. **On Android the crate does not exist** —
    // `tauri-plugin-single-instance`'s `lib.rs` opens with
    // `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, so `init` is not a no-op
    // there, it is an unresolved name. Android needs none of it: the OS runs one task per
    // application and there is no second process to refuse.
    #[cfg(desktop)]
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
        |app, _args, _cwd| {
            focus_existing_window(app);
        },
    ));
    #[cfg(mobile)]
    let builder = tauri::Builder::default();

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // Windows 11 Snap Layouts for the app's own maximize button — and therefore desktop only,
    // since Android draws no caption at all. The crate itself compiles everywhere (a
    // `#[cfg(not(windows))]` dummy that still registers both commands, which is what keeps
    // `capabilities/` resolvable on the Linux CI leg), so this gate is about not *asking* for
    // an overlay over a button that is not on screen.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_snap_layout::init()
            .button_id("snap-maximize-button")
            .build(),
    );
```

Keep the two long comment blocks the original chain carried for dialog, clipboard-manager and
snap-layout — move them, do not delete them. They are the record of why each permission is the
narrow one.

- [ ] **Step 6: Gate the four things that cannot compile or must not run**

Five edits, all in `lib.rs` unless noted:

**a.** `focus_existing_window` — add `#[cfg(desktop)]` above `fn focus_existing_window`. It is
called only from the callback gated in Step 5, and on mobile it would be an unused private
function.

**b.** The `--await-predecessor` block at the top of `run()`:

```rust
    // Desktop only: this is the portable exe swap's handshake, and there is no portable exe on
    // Android. `update::await_predecessor` waits on a Windows process handle and the launch
    // flag is one only a self-replacing build ever passes itself.
    #[cfg(desktop)]
    {
        let exe = std::env::current_exe().unwrap_or_default();
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|a| a == update::AWAIT_FLAG) {
            update::await_predecessor(&exe, update::predecessor_pid(args));
        }
    }
```

**c.** `pub mod window;` becomes:

```rust
// Desktop only. `open_sized_to_monitor` calls `WebviewWindow::center()`, which tauri declares
// `#[cfg(desktop)]` (tauri/src/window/mod.rs:1924) — so this module is not merely useless on a
// phone, it does not compile there. Android's window is the activity and the OS sizes it.
#[cfg(desktop)]
pub mod window;
```

**d.** In `setup`, the first line:

```rust
            // First, and before anything that can fail: the window is created **hidden**
            // (`tauri.conf.json`'s `"visible": false`) on desktop, so until this runs the app
            // has no window at all. Android has no hidden-window step and no rungs to choose
            // between — the activity is already on screen.
            #[cfg(desktop)]
            window::open_sized_to_monitor(app.handle());
```

**e.** In `setup`, the mirror's two halves — keep both comments, add one gate over the pair:

```rust
            // The plain-text mirror, in two halves that must stay in this order. **Desktop
            // only, and this is the decision rather than a limitation**: the mirror's whole
            // point is a folder a reader opens in a text editor, syncs with Dropbox or greps,
            // and on Android that directory is reachable mainly through a file-manager app and
            // often not by other apps at all. See the parity matrix §4.
            //
            // The module still *compiles* on Android — `AppState` carries
            // `mirror::watch::{Mask, LastPass}` and six sites construct them — so what is
            // gated is the hook and the thread, which is the whole of what makes the mirror
            // do anything.
            #[cfg(desktop)]
            {
                mirror::watch::install_hook(&db::lock_blocking(&state.db), state.mirror.clone());
                mirror::watch::spawn(state.clone());
            }
```

> ⚠️ **`db::lock_blocking(&state.db)` is a temporary whose guard must outlive the call.**
> Wrapping it in a block is fine — the guard drops at the closing brace, before
> `mirror::watch::spawn`, which is the same lifetime it had before. If the borrow checker
> disagrees, bind it: `let conn = db::lock_blocking(&state.db); mirror::watch::install_hook(&conn, …); drop(conn);`

- [ ] **Step 7: Build for Android and fix what is left**

```bash
cd src-tauri && cargo build --target aarch64-linux-android --lib 2>&1 | tee /tmp/android-build.log
grep -E "^error" /tmp/android-build.log | head -40
```

**Every error that is not one of the three named at the top of this document is a stop-and-report,
not a step to improvise through.** This plan claims to know exactly three compile breaks; a
fourth means the plan was wrong and the fix belongs in a report before it belongs in the source.
Name it, say what it is, and ask.

- [ ] **Step 8: Confirm desktop did not move**

```bash
cd src-tauri && cargo test 2>&1 | tail -6
cargo clippy --all-targets --locked -- -D warnings
cargo fmt --check
```

The Rust test count must be **the two new `paths` tests higher** than before this task and no
other number may change. Write the before and after counts down.

- [ ] **Step 9: Mutate to prove the new test bites**

Temporarily change `data_dir_for`'s match arm from `Some(dir) if desktop` to `Some(dir)`. Run
`cargo test paths::`; `a_mobile_build_never_probes_beside_the_executable` must **FAIL** on both
assertions — the returned path and the left-behind `data/` directory. Revert.

**Report it if the test survives.** A guard that passes with the condition removed is testing the
temp directory's layout rather than the branch.

- [ ] **Step 10: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/lib.rs src-tauri/src/paths.rs
git commit -m "feat(android): the crate compiles for aarch64-linux-android

Three things could not compile there and are now gated. tauri-plugin-single-instance is an
empty crate on Android — its lib.rs opens with #![cfg(not(any(target_os = \"android\", …)))],
so .plugin(init(..)) was an unresolved name rather than a no-op. WebviewWindow::center() is
#[cfg(desktop)] in tauri, which takes window.rs with it. And the --await-predecessor handshake
belongs to a portable exe that does not exist on a phone.

Two more are gated because they must not RUN: the mirror's update hook and its thread. The
module itself stays compiled, because AppState carries mirror::watch::{Mask, LastPass} and six
sites construct them — spec §6.3's mark is about behaviour, and not running code is the cheap
way to deliver it in a crate whose every pub fn is public API and therefore never dead.

data_dir_for takes cfg!(desktop) as an argument rather than testing it inside, so both branches
compile and are tested on every platform. Android must never probe beside the executable: that
path is the app's native-library directory or /system/bin."
```

> **Redirect `npm run verify` to a file and grep it.** Piping to `tail` reports tail's exit code
> while tests fail underneath.

---

### Task 3: `tauri android init` — the Gradle project, the config, the ignore rules, the CI router

**Files:**
- Create: `src-tauri/gen/android/**` (generated — reviewed, then committed)
- Modify: `src-tauri/tauri.conf.json` — a `bundle.android` block
- Modify: `src-tauri/.gitignore`
- Modify: `.github/workflows/ci.yml` — one `case` arm
- Test: `src-tauri/src/lib.rs`'s existing config tests (see Step 5)

**Interfaces:**
- Consumes: Task 1's SDK/NDK, Task 2's compiling crate.
- Produces: `npm run tauri android build --debug` producing an APK.

- [ ] **Step 1: Generate the project**

```powershell
$env:JAVA_HOME = "<the JDK from Task 1>"
$env:ANDROID_HOME = "<from Task 1>"
$env:NDK_HOME = "<from Task 1>"
Set-Location D:\Code\mtg-grimoire\.claude\worktrees\spike-wasm-core
npx tauri android init
```

**`npx tauri`, not `cargo tauri`.** This machine has the npm CLI (2.11.4) and no cargo
subcommand — `cargo tauri --version` exits 101 with `no such command`.

- [ ] **Step 2: Read what it generated before committing a line of it**

```bash
git status --porcelain src-tauri/gen/android | head -40
find src-tauri/gen/android -name "*.gradle*" -o -name "AndroidManifest.xml" -o -name ".gitignore" | sort
```

Then read, in this order — each answers a question this plan deliberately left open:

| File | The question it answers |
| --- | --- |
| `app/build.gradle.kts` | the real `compileSdk`, `minSdk`, `targetSdk`, and whether `minSdk` came from the template (21) or from the Tauri config default (24) |
| `build.gradle.kts` | the AGP and Kotlin versions actually written, against the 8.11.0 / 1.9.25 read out of the CLI binary |
| `gradle/wrapper/gradle-wrapper.properties` | the Gradle distribution, against `gradle-8.14.3-bin` |
| `app/src/main/AndroidManifest.xml` | **which permissions the template requests**, and whether `android:usesCleartextTraffic` is set |
| `app/.gitignore` and `.gitignore` | what the template already excludes, before adding anything |

**Report anything that disagrees with the four pins above.** They were read out of the shipped
CLI binary and should match; a mismatch means the binary and the template diverge, which is worth
knowing.

> ⚠️ **The manifest's permission list is the one thing here worth an actual review.** This app
> needs `android.permission.INTERNET` and nothing else — no storage permission (the document
> picker grants per-URI access), no location, no camera. A permission in the generated manifest
> that this app does not need is a permission a Play listing has to justify. Delete it and say
> which.

- [ ] **Step 3: Add the Android bundle block to `tauri.conf.json`**

The fields are real — `tauri-utils-2.9.3/src/config.rs:3211` defines `AndroidConfig` with
`min_sdk_version` (default **24**), `version_code`, `auto_increment_version_code` and
`debug_application_id_suffix`.

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "licenseFile": "../LICENSE",
    "android": {
      "minSdkVersion": 26,
      "debugApplicationIdSuffix": ".debug"
    },
    "icon": [
```

**`minSdkVersion` 26 rather than the default 24, and the reason is measurable**: this app's floor
is whatever the system WebView on that release can run, and API 26 (Android 8.0, 2017) is where
the WebView became independently updatable through Play for every device. Going lower widens the
device list and widens the set of WebViews that have to render a React 19 bundle.
**If Task 8 finds a real device that 26 excludes and Markus wants it, this number is the dial** —
do not treat it as settled by this plan.

**`debugApplicationIdSuffix` is `.debug` so a debug build and a release build install side by
side.** Without it, a `tauri android dev` install replaces a release install and takes its data
directory's place in the process — which on a phone means the corpus is rebuilt.

`versionCode` is left unset: Tauri derives it as `major*1000000 + minor*1000 + patch`, which for
`0.17.0` is 17000. That is monotonic as long as release-please only ever moves the version
forward, which it does.

- [ ] **Step 4: Decide what of `gen/android/` is committed**

The Tauri template writes its own `.gitignore` files under `gen/android/`. Read them first
(Step 2), then add to **`src-tauri/.gitignore`** only what they miss:

```gitignore
# Generated by Cargo
# will have compiled files and executables
/target/

# Generated by Tauri
# will have schema files for capabilities auto-completion
/gen/schemas

# The Android Gradle project IS committed — it is a real project with real hand-edits
# (the manifest's permission list, the icons, the signing config), and regenerating it with
# `android init` would silently drop them. What is not committed is what a build produces.
/gen/android/.gradle/
/gen/android/build/
/gen/android/app/build/
/gen/android/local.properties
/gen/android/app/tauri.properties
/gen/android/.idea/
/gen/android/app/*.jks
/gen/android/app/keystore.properties
```

> ⚠️ **`local.properties` names the SDK path on *this* machine and must never be committed.**
> Neither must a keystore or its password file — that is Task 7's stop gate, and the ignore
> lines are here rather than there so the trap is closed before the key exists.

**`app/tauri.properties` is deliberately ignored** because `autoIncrementVersionCode` is off; the
`AndroidConfig` docs say to un-ignore it only if that flag is turned on.

- [ ] **Step 5: Keep the config tests honest**

`src-tauri/src/lib.rs` already has tests that read `tauri.conf.json` at compile time through
`include_str!` — `the_main_window_is_undecorated_and_keeps_its_shadow` and
`the_shipped_csp_allows_ipc_and_images_and_nothing_wild` among them. Find them:

```bash
grep -n "include_str\|tauri.conf.json" src-tauri/src/lib.rs | head
```

Add one beside them:

```rust
    /// The Android bundle block, pinned for the reason every other config assertion here is:
    /// `tauri.conf.json` is embedded at compile time and nothing else in the build reads these
    /// three fields back. A `minSdkVersion` silently dropped in a merge is a build that still
    /// succeeds and an app that installs on devices whose WebView cannot render it.
    #[test]
    fn the_android_bundle_names_its_floor_and_its_debug_suffix() {
        let cfg: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
        let android = &cfg["bundle"]["android"];
        assert_eq!(android["minSdkVersion"], 26);
        assert_eq!(android["debugApplicationIdSuffix"], ".debug");
        // Not set, on purpose: the version code is derived from `version` (0.17.0 -> 17000),
        // which release-please only ever moves forward.
        assert!(android["versionCode"].is_null());
    }
```

Use whatever constant the neighbouring tests already bind `include_str!("../tauri.conf.json")` to
rather than adding a second one.

- [ ] **Step 6: Stop the CI router from lying about a Kotlin edit**

`.github/workflows/ci.yml`'s `changes` job routes `src-tauri/*` to the `rust` job. Every file
under `gen/android/` matches that, so editing an `AndroidManifest.xml` would run the full
clippy-and-test matrix on Windows *and* Linux to prove nothing about the change.

Add an arm **above** the `src-tauri/*` arm — `case` is first-match-wins, which the file's own
comment about `*.ps1` already explains:

```bash
              # The Android Gradle project. Nothing in either build job reads it: `cargo` does
              # not compile Kotlin, `eslint` does not lint a `.gradle.kts`, and the Rust job
              # builds for the host target only. Building an APK needs an SDK and an NDK on the
              # runner, which no job here installs. So this routes nowhere, exactly like `docs/`.
              #
              # **It must sit above `src-tauri/*`** — `case` is first-match-wins, and the arm
              # below would otherwise run the whole Rust matrix for a manifest edit.
              #
              # The one thing this cannot catch is a `gen/android/` change that is really a Rust
              # change in disguise. There is no such file: the bridge between the two is
              # `tauri.conf.json`, which `src-tauri/*` already routes.
              src-tauri/gen/android/*) ;;
```

**Verify it with the workflow's own logic** rather than by reading:

```bash
printf 'src-tauri/gen/android/app/src/main/AndroidManifest.xml\nsrc-tauri/src/lib.rs\n' > /tmp/files.txt
# Re-run the case block from ci.yml against /tmp/files.txt in a scratch script; the manifest
# alone must yield frontend=false rust=false, and the pair must yield rust=true.
```

- [ ] **Step 7: Build a debug APK**

```powershell
npm run tauri android build -- --debug --target aarch64
Get-ChildItem src-tauri\gen\android\app\build\outputs\apk -Recurse -Filter *.apk |
  Select-Object FullName,@{n='MB';e={[math]::Round($_.Length/1MB,1)}}
```

Record the APK size. It is the first Android number this repo has and it belongs in Task 9's
reference doc.

**Falsifier:** a build that "succeeds" and produces no `.apk` under `outputs/`. Check for the
file; do not read the exit code alone.

- [ ] **Step 8: Mutate the config test to prove it bites**

Change `minSdkVersion` to `24` in `tauri.conf.json`, run
`cargo test the_android_bundle_names_its_floor` — it must **FAIL**. Revert both. Report if it
survives; that would mean the test is reading a different file than the build embeds.

- [ ] **Step 9: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/gen/android src-tauri/tauri.conf.json src-tauri/.gitignore .github/workflows/ci.yml
git commit -m "feat(android): the Gradle project, the bundle config and the ignore rules

gen/android/ is committed rather than generated per-machine: it carries hand-edits (the
manifest's permission list, the icons, later the signing config) that `android init` would
silently drop. What is ignored is what a build produces, plus local.properties — which names
this machine's SDK path — and any keystore.

minSdkVersion 26 rather than the config default 24: API 26 is where the system WebView became
independently updatable through Play on every device, and the WebView is what renders this app.
debugApplicationIdSuffix keeps a dev install from taking a release install's data directory.

ci.yml gets one arm, above src-tauri/*, because case is first-match-wins: a Kotlin or Gradle
edit ran the whole clippy-and-test matrix on two operating systems to prove nothing."
```

---

### Task 4: The capability split — one file becomes two, and the mobile one is narrower

**Files:**
- Delete: `src-tauri/capabilities/default.json`
- Create: `src-tauri/capabilities/desktop.json`
- Create: `src-tauri/capabilities/mobile.json`
- Test: inline in `src-tauri/src/lib.rs`, beside the existing capability assertions

**Interfaces:**
- Consumes: Task 3's Gradle project (so the Android schema exists to build against).
- Produces: two capability files whose union on desktop is byte-for-byte the permission set that
  ships today.

> **`platforms` is a real field.** `tauri-utils-2.9.3/src/acl/capability.rs:204` declares
> `pub platforms: Option<Vec<Target>>`, and `Target` serialises as `"macOS"`, `"windows"`,
> `"linux"`, `"android"`, `"iOS"`. Omitting it targets every platform, which is why today's
> single file would otherwise hand Android four window verbs that do not exist there.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/lib.rs`, beside `the_title_bar_gets_four_window_verbs_and_the_overlay_two`
(find it with `grep -n "the_title_bar_gets_four_window_verbs" src-tauri/src/lib.rs`):

```rust
    /// The desktop capability is what shipped as `default.json`, unchanged. Splitting the file
    /// must not be a widening or a narrowing of what the shipped app can do — this is the
    /// assertion that makes the split a refactor.
    #[test]
    fn the_desktop_capability_is_the_permission_set_that_shipped() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
        let got: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        assert_eq!(
            got,
            vec![
                "core:default",
                "opener:default",
                "dialog:allow-open",
                "dialog:allow-save",
                "clipboard-manager:allow-write-text",
                "core:window:allow-minimize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-close",
                "core:window:allow-start-dragging",
                "snap-layout:allow-update-snap-bounds",
                "snap-layout:allow-detach-snap-bounds",
                "mcp-bridge:allow-report-ipc-event",
                "mcp-bridge:allow-request-script-injection",
                "mcp-bridge:allow-script-result",
            ]
        );
        assert_eq!(cap["platforms"], serde_json::json!(["windows", "linux", "macOS"]));
    }

    /// Android's capability, and every absence in it is a decision.
    ///
    /// **The four window verbs are gone because three of them do not exist.** In tauri 2.11.5,
    /// `minimize`, `toggle_maximize` and `start_dragging` are all `#[cfg(desktop)]`
    /// (`tauri/src/window/plugin.rs`); only `close` is in the shared handler, and an app that
    /// can close itself from a button no phone user expects is not a feature. `TitleBar` is
    /// hidden on Android for the same reason — see `src/lib/platform.ts`.
    ///
    /// **Snap Layouts are gone** because there is no caption to park an overlay over.
    ///
    /// **The MCP bridge is gone** because it binds a WebSocket that authenticates nothing and
    /// evaluates arbitrary JavaScript, and `tauri android dev` produces a *debug* build — so
    /// `#[cfg(debug_assertions)]` would put that socket on a phone rather than on this
    /// workstation's loopback. Android is driven over CDP instead (see the reference doc).
    ///
    /// **`opener` is narrowed from `:default` to the one verb.** `opener:default` is
    /// `allow-open-url` + `allow-reveal-item-in-dir` + `allow-default-urls`, and revealing an
    /// item in a directory is not a thing Android's opener supports (its own manifest says
    /// "Only allows to open URLs via `open`"). The scope entry stays: it is what permits
    /// `https:`, `http:`, `mailto:` and `tel:`.
    #[test]
    fn the_mobile_capability_drops_every_verb_the_platform_has_no_answer_for() {
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/mobile.json")).unwrap();
        let got: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        assert_eq!(
            got,
            vec![
                "core:default",
                "opener:allow-open-url",
                "opener:allow-default-urls",
                "dialog:allow-open",
                "dialog:allow-save",
                "clipboard-manager:allow-write-text",
            ]
        );
        assert_eq!(cap["platforms"], serde_json::json!(["android"]));

        for denied in [
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-close",
            "core:window:allow-start-dragging",
            "snap-layout:allow-update-snap-bounds",
            "snap-layout:allow-detach-snap-bounds",
            "mcp-bridge:allow-report-ipc-event",
            "mcp-bridge:allow-request-script-injection",
            "mcp-bridge:allow-script-result",
            "opener:default",
        ] {
            assert!(!got.contains(&denied), "{denied} must not reach Android");
        }

        // No `fs:` permission, on any platform, ever. Task 5 adds `tauri-plugin-fs` to the
        // Android build and reaches it from **Rust**, where the ACL is not in the path. A
        // grant here would be the page gaining a filesystem, which is the one thing this app
        // has never given it.
        assert!(
            !got.iter().any(|p| p.starts_with("fs:")),
            "no fs: permission is granted anywhere"
        );
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test capability 2>&1 | tail -12`
Expected: **compile failure** — `couldn't read ../capabilities/desktop.json`. `include_str!` on a
missing file is a compile error, so this red is unmistakable.

- [ ] **Step 3: Write the two files**

`src-tauri/capabilities/desktop.json` — today's `default.json`, plus `platforms`, plus one
sentence in `description` about why it is now named for a platform set:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "desktop",
  "description": "Capability for the main window on desktop. Split from `default` when the Android target arrived: three of the four window verbs below are `#[cfg(desktop)]` in tauri itself, so an unsplit file would grant a phone commands that do not exist there.",
  "platforms": ["windows", "linux", "macOS"],
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "clipboard-manager:allow-write-text",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "snap-layout:allow-update-snap-bounds",
    "snap-layout:allow-detach-snap-bounds",
    "mcp-bridge:allow-report-ipc-event",
    "mcp-bridge:allow-request-script-injection",
    "mcp-bridge:allow-script-result"
  ]
}
```

`src-tauri/capabilities/mobile.json`:

```json
{
  "$schema": "../gen/schemas/android-schema.json",
  "identifier": "mobile",
  "description": "Capability for the main webview on Android. Every absence here is a decision and the reasons are in `the_mobile_capability_drops_every_verb_the_platform_has_no_answer_for`: no window verbs (three of four are `#[cfg(desktop)]` in tauri and the fourth is a close button no phone user expects), no snap layouts (no caption), no MCP bridge (an unauthenticated WebSocket on a phone), and `opener` narrowed from its `:default` to the one verb Android supports.",
  "platforms": ["android"],
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:allow-open-url",
    "opener:allow-default-urls",
    "dialog:allow-open",
    "dialog:allow-save",
    "clipboard-manager:allow-write-text"
  ]
}
```

Then `git rm src-tauri/capabilities/default.json`.

> ⚠️ **`gen/schemas/` is gitignored, so both `$schema` lines are editor conveniences and neither
> is read by the build.** `android-schema.json` appears only after Task 3's `android init`. A
> missing schema file is not an error.

- [ ] **Step 4: Prove the desktop app still has its permissions, in the running window**

A capability file that resolves is not a capability file that works. Take the `app` lock, run
`npm run tauri dev`, and press the maximize button. If `core:window:allow-toggle-maximize` did
not survive the split, the button does nothing and **nothing is logged** — the ACL denial goes
to the promise `toggleMaximizeWindow()` returns, which `TitleBar` does not await into a visible
error.

```powershell
pwsh -File .claude/skills/running-the-app/lock.ps1 claim app
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

From another shell, and **in two evals, because clicking and reading in one answers about the
frame before React re-rendered**:

```powershell
node scripts/cdp.mjs hover "#snap-maximize-button" --rest 200
node scripts/cdp.mjs click "#snap-maximize-button"
node scripts/cdp.mjs eval "(() => ({ w: window.outerWidth, h: window.outerHeight }))()"
```

A cold pointer makes `click` a no-op that still prints "clicked", which is why the `hover` comes
first.

Release the lock when done.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test capability 2>&1 | tail -12`
Expected: `test result: ok. 3 passed` — the two new ones plus the existing
`the_title_bar_gets_four_window_verbs_and_the_overlay_two`. **Confirm the number**; a filter that
selects nothing exits 0.

If the existing test reads `default.json` by name it will now fail to compile — update its
`include_str!` to `desktop.json` and say so, since that is a real edit to a test this task did not
plan to touch.

- [ ] **Step 6: Mutate to prove the mobile test bites**

Add `"core:window:allow-close"` to `mobile.json`'s permission list. Run
`cargo test the_mobile_capability`; it must **FAIL** on both the `assert_eq!` of the list and the
`denied` loop. Revert. Report if only one of the two fires — the loop is the one that catches a
permission appended in a merge.

- [ ] **Step 7: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/capabilities .github/../src-tauri/src/lib.rs
git commit -m "feat(android): capabilities split by platform, and the mobile one is narrower

default.json targeted every platform because there was only one. On Android that would have
granted four window verbs, three of which tauri declares #[cfg(desktop)] and does not ship —
minimize, toggle_maximize and start_dragging — plus a close the OS already owns, plus Snap
Layouts over a caption that is not drawn, plus an MCP bridge that binds an unauthenticated
WebSocket and would land on the phone because `tauri android dev` is a debug build.

opener is narrowed from :default to allow-open-url + allow-default-urls. The third verb in
that set reveals an item in a directory, which the plugin's own manifest says Android does
not support.

No fs: permission on either platform, and the test asserts it. Task 5's Android file reads go
through the Rust-side Fs handle, where the ACL is not in the path."
```

---

### Task 5: A picked file on Android is a `content://` URI

**This is the one genuinely new mechanism in this PR.** Everything else is a gate or a config.

**Files:**
- Modify: `src-tauri/Cargo.toml` — `tauri-plugin-fs` as an Android-only dependency
- Modify: `src-tauri/Cargo.lock` — in the same commit
- Modify: `src-tauri/src/lib.rs` — register the plugin on Android
- Create: `src-tauri/src/picked.rs` — one function, two implementations
- Modify: `src-tauri/src/lib.rs` — `pub mod picked;`
- Modify: `src-tauri/src/import.rs`, `src-tauri/src/export.rs`, `src-tauri/src/images.rs`, `src-tauri/src/deck.rs`
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/picked.rs`

**Interfaces:**
- Consumes: Task 4's capability files (which grant `fs:` nothing).
- Produces: `picked::open_read(app, &str) -> Result<Box<dyn Read + Send>, String>` and
  `picked::write_all(app, &str, &[u8]) -> Result<(), String>`.

> **What was verified.** `tauri-plugin-dialog-2.7.2/android/src/main/java/DialogPlugin.kt` fires
> `Intent.ACTION_OPEN_DOCUMENT` and `Intent.ACTION_CREATE_DOCUMENT` and returns
> `uri.toString()`. Its Rust side deserialises into `FilePath`, whose docs
> (`tauri-plugin-fs-2.5.1/src/file_path.rs:17`) name "`file://` URIs or Android `content://`
> URIs" explicitly. So `import_read_file("content://com.android.providers.downloads…")` reaching
> `std::fs::read` is a guaranteed `No such file or directory`.
>
> **And what resolves it.** `tauri_plugin_fs::Fs::open` (`src/android.rs:31`) takes a
> `FilePath::Url`, calls the Kotlin `getFileDescriptor` through the `ContentResolver`, and hands
> back a **`std::fs::File`** built from the raw fd. That is a plain `Read`/`Write`, so every
> existing byte-handling path downstream is unchanged.

> ⚠️ **This adds a plugin and grants it nothing, and that is correct rather than an oversight.**
> Tauri v2's ACL gates commands **invoked from the webview**. `Fs::open` is a Rust-side method on
> a managed handle; no `invoke` crosses the boundary and no permission is consulted. So the page
> still cannot read or write a byte of the filesystem — `capabilities/mobile.json` grants no
> `fs:` entry and Task 4's test asserts it — while Rust can open exactly the one URI the reader
> chose in the OS's own picker a moment earlier. **That is the app's existing habit, not a new
> one**: `src-tauri/CLAUDE.md`'s "a dialog verb answers a *path*, and a path is not permission
> to touch what is at it" says the answer to a new file need is another twelve-line command,
> never a wider capability. This is that command.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/picked.rs` with only this:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop shape. A path is a path and nothing is resolved.
    #[test]
    fn a_plain_path_is_not_a_content_uri() {
        assert!(!is_content_uri("C:\\Users\\m\\deck.txt"));
        assert!(!is_content_uri("/home/m/deck.txt"));
        assert!(!is_content_uri("/storage/emulated/0/Download/deck.txt"));
    }

    /// What Android's document picker actually answers, verbatim from a real intent result.
    #[test]
    fn the_document_pickers_answer_is_a_content_uri() {
        assert!(is_content_uri(
            "content://com.android.providers.downloads.documents/document/msf%3A1000000042"
        ));
        assert!(is_content_uri("content://media/external/images/media/1234"));
    }

    /// Case, because a scheme is case-insensitive and nothing guarantees the provider
    /// lower-cases it. A miss here is a file the app refuses to open with "No such file".
    #[test]
    fn the_scheme_is_matched_case_insensitively() {
        assert!(is_content_uri("CONTENT://media/external/images/media/1"));
        assert!(is_content_uri("Content://x/y"));
    }

    /// A `file://` URI is NOT a content URI and must not be routed through the resolver — the
    /// desktop picker can answer one, and `Fs::open` would take it too, but the plain path
    /// branch is the one with the error messages this app already writes.
    #[test]
    fn a_file_uri_is_not_a_content_uri() {
        assert!(!is_content_uri("file:///home/m/deck.txt"));
    }

    /// The empty string and a bare word are paths, not URIs. A permissive prefix test that
    /// answered `true` for `"content"` would send a filename to the ContentResolver.
    #[test]
    fn a_bare_word_is_a_path() {
        assert!(!is_content_uri(""));
        assert!(!is_content_uri("content"));
        assert!(!is_content_uri("contents.txt"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod picked;` to `src-tauri/src/lib.rs` **first**, in alphabetical position between
`pub mod paths;` and `pub mod reconcile;`.

> ⚠️ **Declare the module before the first red step, always.** An undeclared module compiles
> nothing and cargo reports `running 0 tests … ok` and exits 0. This repo has lost four waves of
> work to exactly that, and the feed-pipeline plan walked into it in its own Task 1.

Run: `cd src-tauri && cargo test picked:: 2>&1 | tail -12`
Expected: **compile failure**, `cannot find function 'is_content_uri'`.

- [ ] **Step 3: Write the implementation**

Above the test module in `src-tauri/src/picked.rs`:

```rust
//! Opening the file the reader picked, which is not the same kind of thing on every platform.
//!
//! On desktop and on the mirror's own paths a picked file is a **path**, and `std::fs` opens
//! it. On Android it is a **`content://` URI**: `tauri-plugin-dialog`'s `DialogPlugin.kt`
//! fires `ACTION_OPEN_DOCUMENT`/`ACTION_CREATE_DOCUMENT` and returns `uri.toString()`, which
//! names a row in a ContentProvider rather than anything on a filesystem. `std::fs::read` of
//! one answers `No such file or directory`, which reads exactly like the reader picked a file
//! that vanished.
//!
//! **The three commands behind the three pickers all funnel here** —
//! [`crate::import::import_read_file`], [`crate::export::export_write_file`] and
//! [`crate::deck::deck_set_cover_image`] — so there is one place that knows the difference and
//! three that do not.
//!
//! **No `fs:` permission is granted anywhere and none is needed.** Tauri's ACL gates commands
//! the *webview* invokes; [`tauri_plugin_fs::Fs::open`] is a Rust-side method on a managed
//! handle. The page still cannot touch a byte of the filesystem, and Rust opens exactly the one
//! URI the reader chose in the OS's own picker. That is this app's standing habit, written down
//! in `src-tauri/CLAUDE.md`: a dialog verb answers a name, and a name is not permission.

use std::io::{Read, Write};

/// Whether this string is an Android document-provider URI rather than a path.
///
/// A `file://` URI is deliberately **not** one: the desktop picker can answer one, and the
/// plain-path branch already carries the error messages this app writes for a file it cannot
/// read. Matching only `content:` keeps the resolver path to the one platform that needs it.
///
/// Case-insensitive, because a URI scheme is, and nothing promises a provider lower-cases it.
pub fn is_content_uri(s: &str) -> bool {
    s.len() > "content://".len() && s[.."content://".len()].eq_ignore_ascii_case("content://")
}

/// Open the picked file for reading.
///
/// Returns a boxed reader rather than bytes so a caller that wants to bound its read — which
/// [`crate::import::read_import_file`] does, at 1 MB — can still do so. On Android the
/// underlying value is a `std::fs::File` built from a file descriptor the ContentResolver
/// handed over, so `Read` behaves identically on both platforms.
pub fn open_read(
    #[allow(unused_variables)] app: &tauri::AppHandle,
    picked: &str,
) -> Result<Box<dyn Read + Send>, String> {
    #[cfg(target_os = "android")]
    if is_content_uri(picked) {
        use tauri::Manager as _;
        let fs = app
            .try_state::<tauri_plugin_fs::Fs<tauri::Wry>>()
            .ok_or_else(|| "the file plugin is not ready".to_owned())?;
        let url = url::Url::parse(picked).map_err(|e| format!("{picked} is not a URI: {e}"))?;
        let file = fs
            .open(
                tauri_plugin_fs::FilePath::Url(url),
                tauri_plugin_fs::OpenOptions::new().read(true).clone(),
            )
            .map_err(|e| format!("That file could not be opened — {e}"))?;
        return Ok(Box::new(file));
    }

    let file = std::fs::File::open(picked)
        .map_err(|e| format!("That file could not be opened — {e}"))?;
    Ok(Box::new(file))
}

/// Write `bytes` at the picked destination, replacing whatever was there.
///
/// Truncating rather than appending, exactly as [`crate::export::write_export`] was: the reader
/// picked this name in a save dialog that had already asked them about overwriting. On Android
/// `ACTION_CREATE_DOCUMENT` has already created the row, so this writes into a descriptor the
/// provider opened in truncate mode.
pub fn write_all(
    #[allow(unused_variables)] app: &tauri::AppHandle,
    picked: &str,
    bytes: &[u8],
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if is_content_uri(picked) {
        use tauri::Manager as _;
        let fs = app
            .try_state::<tauri_plugin_fs::Fs<tauri::Wry>>()
            .ok_or_else(|| "the file plugin is not ready".to_owned())?;
        let url = url::Url::parse(picked).map_err(|e| format!("{picked} is not a URI: {e}"))?;
        let mut file = fs
            .open(
                tauri_plugin_fs::FilePath::Url(url),
                tauri_plugin_fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .clone(),
            )
            .map_err(|e| format!("could not write {picked}: {e}"))?;
        return file
            .write_all(bytes)
            .map_err(|e| format!("could not write {picked}: {e}"));
    }

    std::fs::write(picked, bytes).map_err(|e| format!("could not write {picked}: {e}"))
}
```

> ⚠️ **`OpenOptions` here is `tauri_plugin_fs`'s, not `std`'s, and its builder shape is not
> guaranteed to be the one written above.** Read
> `~/.cargo/registry/src/index.crates.io-*/tauri-plugin-fs-2.5.1/src/models.rs` and match it. If
> it differs, fix the call and **say so in the commit** — a builder guessed from familiarity is
> exactly the kind of confident step over an unknown this plan is meant not to contain.
>
> **`url::Url` is already in the tree** (reqwest and tauri both pull it), but it is not a direct
> dependency of this crate. Either add `url = "2"` to the Android-only dependency block or take
> the `FilePath: FromStr` route if the plugin offers one — check `file_path.rs` and use whichever
> exists.

- [ ] **Step 4: Add the plugin, Android-only, and register it**

In `src-tauri/Cargo.toml`, after the `[target.'cfg(windows)'.dependencies]` block:

```toml
# Android only, and reached only from Rust. A file the reader picks on Android is a
# `content://` URI, not a path: `tauri-plugin-dialog`'s DialogPlugin.kt fires
# ACTION_OPEN_DOCUMENT / ACTION_CREATE_DOCUMENT and returns `uri.toString()`. This plugin's
# `Fs::open` resolves such a URI through the ContentResolver and hands back a std::fs::File
# built from the descriptor — which is what lets `picked.rs` keep every byte-handling path
# downstream unchanged.
#
# **No `fs:` permission is granted to it, on any platform.** The ACL gates commands the webview
# invokes; this is a Rust-side handle. The page's filesystem access is unchanged: none.
# See `capabilities/mobile.json` and `the_mobile_capability_drops_every_verb…`.
#
# It was already in `Cargo.lock` transitively — `tauri-plugin-dialog` depends on it — so this
# adds a direct edge rather than a new crate.
[target.'cfg(target_os = "android")'.dependencies]
tauri-plugin-fs = "2"
url = "2"
```

In `lib.rs`'s plugin chain, after the clipboard-manager line:

```rust
    // Android only, and it is here for `picked.rs` alone — see that module. Registering it is
    // what makes `app.state::<tauri_plugin_fs::Fs<_>>()` resolvable and what wires the Kotlin
    // `FsPlugin` into the activity. **It grants the webview nothing**: `capabilities/mobile.json`
    // has no `fs:` entry, so every one of this plugin's own commands is denied at the ACL.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_fs::init());
```

Then `cargo build` once on Windows so `Cargo.lock` records the new direct edges, and commit the
lock **in the same commit** — `cargo clippy --locked` in CI fails otherwise.

- [ ] **Step 5: Route the three commands through it**

**`import.rs`** — `read_import_file` takes an `AppHandle` and a `&str`, and bounds the read
rather than stat-ing first, because a ContentProvider has no `metadata()`:

```rust
fn read_import_file(app: &tauri::AppHandle, picked: &str) -> Result<String, String> {
    let mut reader = crate::picked::open_read(app, picked)?;
    // **A bounded read rather than a `metadata()` check**, and the change is Android's: a
    // `content://` URI has no size to stat, so the ceiling has to be enforced by how much is
    // read. `take(MAX + 1)` then a length test is the whole of it — one byte over the limit is
    // read and refused, and nothing larger is ever in memory.
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("That file could not be read — {e}"))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(format!(
            "That file is over {} MB. A decklist is text; this reads at most 1 MB.",
            MAX_IMPORT_BYTES / 1_000_000
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn import_read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_import_file(&app, &path))
        .await
        .map_err(|e| format!("the decklist file could not be read: {e}"))?
}
```

> ⚠️ **The size-refusal message changes, and an existing test may pin the old wording.** The old
> one printed the exact size from `metadata()`; the new one cannot know it. Grep for it —
> `grep -rn "A decklist is text" src-tauri/src src` — and update every copy, including any story
> or `.storybook/fake/` line. A message asserted in two places and changed in one is the shape of
> a green build that ships the wrong sentence.
>
> **`import_read_file` gains an `app` argument.** `src/lib/ipc.ts` names this command and
> `ipc.test.ts` pins its argument names — but `AppHandle` is injected by Tauri and does **not**
> appear on the wire, so the TS side is unchanged. Confirm that by running `ipc.test.ts` rather
> than by believing it.

**`export.rs`** — `write_export` takes the handle and delegates:

```rust
fn write_export(app: &tauri::AppHandle, picked: &str, contents: &str) -> Result<(), String> {
    crate::picked::write_all(app, picked, contents.as_bytes())
}

#[tauri::command]
pub async fn export_write_file(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_export(&app, &path, &contents))
        .await
        .map_err(|e| format!("the export could not be written: {e}"))?
}
```

The three existing `export::tests` pass a `tempfile` path; they now need an `AppHandle`. Rather
than building a mock app, **split the test target**: keep the three tests against
`crate::picked::write_all`'s desktop branch by calling `std::fs::write` semantics through a
`#[cfg(not(target_os = "android"))]` free function, or use `tauri::test::mock_app()` if the
`test` feature is enabled in dev-dependencies. **Check which the crate already does** —
`grep -rn "mock_app\|tauri::test" src-tauri/src | head` — and follow it. If neither exists, keep
the three tests on a `write_bytes(path, bytes)` helper that `picked::write_all`'s desktop branch
calls, so the assertions survive without a mock.

**`images.rs`** — `encode_cover` gains a sibling that takes a reader-factory, because it opens
the source **twice** (once for `into_dimensions`, once to decode, and the comment there explains
why the two-pass shape is the strict way to bound `MAX_COVER_SOURCE_PIXELS`):

```rust
/// [`encode_cover`], for a source that may be an Android `content://` URI.
///
/// **Two opens, not one, and the reason is the existing two-pass bound**: the header is read on
/// a pass of its own so the pixel-count ceiling is checked before anything is decoded, and
/// `into_dimensions` consumes its reader. Reading the whole file into a `Vec` first would make
/// one open do, and would also put an arbitrarily large photo in a phone's memory before the
/// ceiling that exists to prevent exactly that has been consulted.
pub fn encode_cover_picked(app: &tauri::AppHandle, picked: &str) -> Result<Vec<u8>, String> {
    let open = || -> Result<_, String> {
        let reader = crate::picked::open_read(app, picked)?;
        image::ImageReader::new(std::io::BufReader::new(reader))
            .with_guessed_format()
            .map_err(|e| format!("could not read {picked}: {e}"))
    };
    // …the rest is `encode_cover`'s body verbatim, with `source.display()` replaced by `picked`.
}
```

> **Do not delete `encode_cover`.** Grep for its callers first — `grep -rn "encode_cover"
> src-tauri/src` — and only fold the two together if `deck_set_cover_image` is genuinely the only
> one. Its tests, if it has any, are the reason to keep the path-taking form.

**`deck.rs`** — `deck_set_cover_image` already takes an `app: tauri::AppHandle`; change one line:

```rust
        let bytes = crate::images::encode_cover_picked(&app, &source_path)?;
```

`app` is currently moved into `covers_dir(&app)` before the blocking task — clone it into the
closure the way `state` already is.

- [ ] **Step 6: Run the tests**

Run: `cd src-tauri && cargo test picked:: 2>&1 | tail -12`
Expected: `test result: ok. 5 passed`. **Confirm the 5.**

Then the whole suite: `cargo test 2>&1 | tail -6`. The total must be **5 higher** than after Task
2, minus however many `export::tests` were restructured — write both numbers down, and if the
delta is not what you expect, find out why before committing.

- [ ] **Step 7: Mutate to prove the URI test bites**

Change `is_content_uri` to `s.starts_with("content")`. Run `cargo test picked::`;
`a_bare_word_is_a_path` must **FAIL** on both `"content"` and `"contents.txt"`. Revert.

Then change it to `s.starts_with("content://")` (case-sensitive). Run again;
`the_scheme_is_matched_case_insensitively` must **FAIL**. Revert.

**Report if either survives.** The second mutation is the one that matters: a case-sensitive
scheme test is a bug that only fires against a provider nobody tested with, and it would present
as "that file could not be opened" on one phone and not another.

- [ ] **Step 8: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/picked.rs src-tauri/src/lib.rs src-tauri/src/import.rs \
        src-tauri/src/export.rs src-tauri/src/images.rs src-tauri/src/deck.rs \
        src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(android): a picked file is a content:// URI, and Rust opens it

tauri-plugin-dialog's DialogPlugin.kt fires ACTION_OPEN_DOCUMENT and ACTION_CREATE_DOCUMENT
and answers uri.toString(), so on Android all three of import_read_file, export_write_file and
deck_set_cover_image were handing a ContentProvider row to std::fs and getting 'No such file
or directory'. picked.rs is the one place that knows the difference; the three commands do not.

tauri-plugin-fs enters as an Android-only DIRECT dependency (it was already in the lock
transitively, as dialog's own). It is granted no fs: permission on any platform and needs
none: the ACL gates commands the webview invokes, and Fs::open is a Rust-side handle. The
page's filesystem access is unchanged — none — which is the habit src-tauri/CLAUDE.md already
records: a dialog verb answers a name, and a name is not permission.

read_import_file now bounds by reading rather than by metadata(), because a content:// URI has
no size to stat. The refusal message changed with it."
```

---

### Task 6: The frontend knows which platform it is on

**Files:**
- Create: `src/lib/platform.ts`
- Create: `src/lib/platform.test.ts`
- Modify: `src/components/AppShell.tsx` — the `TitleBar` row
- Modify: `src/features/settings/SettingsPage.tsx` — the Backup panel
- Modify: `src/features/settings/BackupPanel.tsx` — nothing, if `SettingsPage` gates it
- Test: `src/components/AppShell.test.tsx`, `src/features/settings/SettingsPage` tests if any

**Interfaces:**
- Consumes: nothing from Tasks 2–5.
- Produces: `isAndroid(userAgent?: string): boolean` from `src/lib/platform.ts`.

> **A user-agent test rather than a new command or a plugin, and the precedent is in the repo.**
> `src/lib/images.ts`'s `imageOrigin(userAgent)` already decides the custom-protocol origin from
> `userAgent.includes("Android")`, is pinned by a test, and has shipped. Adding
> `@tauri-apps/plugin-os` for one boolean would be a dependency, a permission and a round trip;
> asking Rust would be a 137th command and an async answer for something three components need
> synchronously during their first render.

- [ ] **Step 1: Write the failing test**

Create `src/lib/platform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAndroid } from "./platform";

/** Taken from the OnePlus 12 (CPH2581), Android 16, in the app's own WebView. */
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 16; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.173 Mobile Safari/537.36";
/** WebView2 on this workstation. */
const WINDOWS_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";

describe("isAndroid", () => {
  it("is true in the app's Android WebView", () => {
    expect(isAndroid(ANDROID_WEBVIEW)).toBe(true);
  });

  it("is false in WebView2 on Windows", () => {
    expect(isAndroid(WINDOWS_WEBVIEW2)).toBe(false);
  });

  /**
   * jsdom's default user agent names neither, and every component test and every story runs
   * under it. If an absent match ever became `true`, the whole suite would silently start
   * testing the phone layout — which is the failure this case exists to make loud.
   */
  it("is false for an unknown agent, so tests and stories get the desktop shape", () => {
    expect(isAndroid("Mozilla/5.0 (unknown) jsdom/30")).toBe(false);
    expect(isAndroid("")).toBe(false);
  });

  /**
   * A desktop Chrome pretending to be a phone in device-emulation mode. It IS Android as far as
   * the page is concerned and must read as one — this is the mode a live pass uses to look at
   * the phone shape without a phone, and a test that excluded it would make that impossible.
   */
  it("is true under device emulation, because the page cannot tell the difference", () => {
    expect(isAndroid("Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/151 Mobile Safari/537.36")).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/platform.test.ts 2>&1 | tail -12`
Expected: `Failed to resolve import "./platform"`. Four failing cases, not zero.

- [ ] **Step 3: Write `src/lib/platform.ts`**

```ts
/**
 * Which platform this page is running on, for the three places the answer changes what is
 * drawn.
 *
 * **A user-agent test rather than a Tauri call, and `src/lib/images.ts` is the precedent.**
 * `imageOrigin()` there already decides the custom-protocol origin from
 * `userAgent.includes("Android")` and has shipped. Asking `@tauri-apps/plugin-os` would be a
 * dependency, a capability entry and an async answer; asking Rust would be a 137th command.
 * Three components need this during their first render, synchronously, and the string is
 * already in the document.
 *
 * **It answers `false` for anything it does not recognise**, which is what keeps jsdom and
 * Storybook on the desktop shape without either of them having to say so. The suite would
 * otherwise change what it tests the day this function got looser.
 *
 * This is *not* a general platform detector and should not grow into one. The web target
 * (Phase 2) runs in a browser on all three of these operating systems, so "is this Android"
 * and "is this the Android app" are different questions the moment the PWA ships — at which
 * point the answer moves behind Boundary A, where `ipc.ts` already knows which core it is
 * talking to.
 */
export function isAndroid(userAgent: string = navigator.userAgent): boolean {
  return userAgent.includes("Android");
}
```

- [ ] **Step 4: Hide the window chrome**

In `src/components/AppShell.tsx`, replace `<TitleBar />` with:

```tsx
      {/* **Not on Android, and it is three of its four buttons that decide it.** In tauri
          2.11.5 `minimize`, `toggle_maximize` and `start_dragging` are all `#[cfg(desktop)]`
          (`tauri/src/window/plugin.rs`) — they are not commands there at all — and
          `capabilities/mobile.json` grants none of the four. The fourth, `close`, exists and
          would kill the app from a button no phone user is looking for. The OS owns the frame;
          see the parity matrix §5.

          The long comment above about `LAYER.caption` still governs, on the platform that
          draws it. */}
      {!isAndroid() && <TitleBar />}
```

Add `import { isAndroid } from "@/lib/platform";` to the imports, and keep the existing comment
block — it records a bug that took a live pass to find.

- [ ] **Step 5: Hide the Backup panel**

In `src/features/settings/SettingsPage.tsx`, wrap `<BackupPanel />`:

```tsx
      {/* **Desktop only, and the decision is the parity matrix's §4 rather than a limitation.**
          The mirror's whole point is a folder a reader opens in a text editor, syncs with
          Dropbox or greps; on Android that directory is reachable mainly through a
          file-manager app and often not by other apps at all, so the feature would exist
          without delivering what it is for. The picker it needs is not there either —
          `tauri-plugin-dialog`'s own manifest records Android support as "partial — Does not
          support folder picker".

          Rust agrees from the other side: `lib.rs` installs neither the mirror's update hook
          nor its thread on mobile, so `mirror_status` would answer a mirror that cannot
          run. */}
      {!isAndroid() && <BackupPanel />}
```

**Find where `BackupPanel` actually sits in that JSX first** — this plan does not name a line
number, and the panel's neighbours carry comments about ordering ("ordered by what a press
costs") that must not be disturbed.

- [ ] **Step 6: Pin both gates in the component tests**

`AppShell.test.tsx` and whatever covers `SettingsPage` mount under jsdom, where `isAndroid()`
answers `false` — so the existing tests already assert the desktop shape and need no change.
Add the other direction to `AppShell.test.tsx`:

```tsx
  /**
   * The caption is the one row nothing the app draws may cover, on the platform that draws it.
   * On Android it must not be drawn at all: three of its four buttons are commands tauri does
   * not ship there, and `capabilities/mobile.json` grants none of the four.
   *
   * `vi.stubGlobal` on `navigator` rather than a prop, because `isAndroid()` reads
   * `navigator.userAgent` by default and the point is to test the default.
   */
  it("draws no window caption on Android", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 16; CPH2581) AppleWebKit/537.36 Chrome/151 Mobile Safari/537.36",
    );
    render(<AppShell {/* whatever props the neighbouring tests pass */} />);
    expect(screen.queryByRole("button", { name: /minimi[sz]e/i })).not.toBeInTheDocument();
  });
```

> ⚠️ **A greyed or renamed control's accessible name includes more than its label.** Use a regex,
> and check what `TitleBar` actually names its buttons — `grep -n "aria-label" src/components/TitleBar.tsx`
> — rather than assuming "Minimize".

- [ ] **Step 7: Run the tests**

```bash
npx vitest run src/lib/platform.test.ts src/components/AppShell.test.tsx 2>&1 | tail -15
```

Expected: the four new `platform` cases plus AppShell's existing count plus one. **Write both
numbers down.**

- [ ] **Step 8: Mutate to prove the gates bite**

Change `isAndroid` to `return true;`. Run the two files above: the AppShell caption test's
*siblings* must fail (whatever asserts the caption is present on desktop), and
`is false in WebView2 on Windows` must fail. Revert.

**If nothing but the platform test fails, the AppShell gate is untested** — the suite would then
go green with the caption gone on desktop, which is a window a reader cannot close. Add the
positive assertion before moving on.

- [ ] **Step 9: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src/lib/platform.ts src/lib/platform.test.ts src/components/AppShell.tsx \
        src/components/AppShell.test.tsx src/features/settings/SettingsPage.tsx
git commit -m "feat(android): the page knows it is on a phone, and hides two desktop surfaces

A user-agent test rather than a plugin or a command, following src/lib/images.ts's shipped
precedent — three components need the answer synchronously during their first render and the
string is already in the document. It answers false for anything it does not recognise, which
is what keeps jsdom and Storybook on the desktop shape without either saying so.

TitleBar goes, because three of its four verbs are #[cfg(desktop)] in tauri 2.11.5 and are not
commands on Android at all, and capabilities/mobile.json grants none of the four. BackupPanel
goes, because the mirror is desktop-only by decision and because the dialog plugin's own
manifest records Android's picker as having no folder mode."
```

---

### Task 7: Updates come from Play, and the app says so

**Files:**
- Modify: `src-tauri/src/update.rs` — a fourth `InstallKind`
- Modify: `src-tauri/src/lib.rs` — the update check is not spawned on Android
- Modify: `src/lib/ipc.ts` — the DTO mirror
- Modify: `src/features/settings/UpdatePanel.tsx`
- Test: inline in `update.rs`; `src/features/settings/UpdatePanel.test.tsx`

**Interfaces:**
- Consumes: Task 6's `isAndroid` (not required, but the panel may use it).
- Produces: `InstallKind::Managed`, serialising as `"managed"`.

> **Why a fourth variant and not `Other`.** `InstallKind::Other` already means "gets the release
> page and nothing else", and `update_open_release_page` opens this repo's GitHub releases — a
> page offering a Windows `.exe` and an NSIS installer to someone holding a phone. That is worse
> than saying nothing. `Managed` means "something else installs this app", which is true, is
> typed, and makes the TS union exhaustive so `UpdatePanel` cannot forget it.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/update.rs`'s test module:

```rust
    /// Android's install kind is decided by the platform, not by probing the disk. The probe
    /// `detect_install_kind` runs — creating `.mtg-grimoire-write-probe` beside the executable —
    /// would be attempted in the app's own native-library directory or under `/system/bin`, and
    /// its answer would mean nothing either way: nothing on a phone can replace the running
    /// binary except the store that installed it.
    #[test]
    fn a_managed_install_is_decided_by_the_platform_and_not_by_a_probe() {
        assert_eq!(classify_managed(true), InstallKind::Managed);
        // The desktop arms are unchanged: `classify` still decides those.
        assert_eq!(
            classify_managed(false),
            classify(cfg!(windows), false, true)
        );
    }

    /// `Managed` can download nothing. `pick_asset` must refuse before it ever matches a
    /// filename — a release's `-setup.exe` is not an answer to a phone, and neither is the
    /// portable zip.
    #[test]
    fn a_managed_install_picks_no_asset() {
        let assets = vec![
            Asset {
                name: "mtg-grimoire-0.18.0-portable.zip".into(),
                url: "https://example.invalid/p".into(),
                size: 1,
                digest: Some("sha256:00".into()),
            },
            Asset {
                name: "mtg-grimoire-0.18.0-setup.exe".into(),
                url: "https://example.invalid/s".into(),
                size: 1,
                digest: Some("sha256:00".into()),
            },
        ];
        assert!(pick_asset(&assets, InstallKind::Managed).is_none());
        // And the two that DO pick still do — this is the assertion that makes the addition a
        // widening rather than a change.
        assert!(pick_asset(&assets, InstallKind::Portable).is_some());
        assert!(pick_asset(&assets, InstallKind::Nsis).is_some());
    }

    /// The wire name, because `src/lib/ipc.ts` mirrors this union by hand and a rename here
    /// with no rename there is a status the panel renders as nothing at all.
    #[test]
    fn managed_serialises_as_the_name_the_typescript_union_carries() {
        assert_eq!(
            serde_json::to_string(&InstallKind::Managed).unwrap(),
            "\"managed\""
        );
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test update::tests 2>&1 | tail -12`
Expected: compile failure — `no variant named 'Managed'`.

- [ ] **Step 3: Implement**

In `update.rs`:

```rust
pub enum InstallKind {
    /// The portable exe. Updates by replacing itself in place and relaunching.
    Portable,
    /// An NSIS install. Updates by handing off to the downloaded setup.
    Nsis,
    /// Something else installs this app and this app does not update itself: the Play Store on
    /// Android. **Not `Other`**, which means "we could not tell, here is the release page" —
    /// and a release page offering a Windows installer to someone on a phone is worse than
    /// saying nothing. This one has an answer and it is "the store has it".
    Managed,
    /// An MSI install, a Linux build, or anything unrecognised. Gets the release page and
    /// nothing else — see the module docs.
    Other,
}
```

```rust
/// [`detect_install_kind`], with the platform question asked first.
///
/// A parameter rather than a `cfg!` in the body, so both arms compile and are tested on every
/// platform — the same reasoning as `paths::data_dir_for`.
pub fn classify_managed(managed: bool) -> InstallKind {
    if managed {
        return InstallKind::Managed;
    }
    classify(cfg!(windows), false, true)
}
```

> ⚠️ **`classify_managed(false)` above delegates with hardcoded `false, true`, which is wrong for
> a real desktop call.** Read `detect_install_kind`'s body and make `classify_managed` take the
> same three inputs it does, or make `Updater::new` call `classify_managed(cfg!(mobile))` before
> ever touching the disk and fall through to `detect_install_kind(exe_dir)` otherwise. **The
> second shape is the right one** — it is the one that skips the write probe entirely on a phone,
> which is the whole point. Fix the test's second assertion to match whichever you build; the
> version above is a sketch and the source is the authority.

`pick_asset` gains an arm:

```rust
        InstallKind::Managed | InstallKind::Other => return None,
```

`Updater::new` decides without probing on mobile:

```rust
        let kind = if cfg!(mobile) {
            InstallKind::Managed
        } else {
            exe.parent().map_or(InstallKind::Other, detect_install_kind)
        };
```

In `lib.rs`'s `setup`, the daily check is not spawned:

```rust
            // The daily update check — desktop only. On Android the store is what notices a
            // new release, and asking GitHub would spend a request and a row of `app_meta` to
            // learn something the app cannot act on.
            #[cfg(desktop)]
            tauri::async_runtime::spawn(async move {
                if let Err(e) = update::check(&state, &updater, false).await {
                    eprintln!("update check failed: {e}");
                }
            });
```

> ⚠️ **`state` and `updater` are moved into that closure and this is the last use of both.**
> Gating it out on mobile turns them into unused bindings and `-D warnings` will say so. Bind
> them with a leading underscore, or move the `#[cfg(desktop)]` up to cover the two `let`s
> above it — read the surrounding lines and pick whichever leaves the desktop path identical.

Also gate `update::clean_up(&exe)` in `setup`: it deletes a staged `.new` beside the executable,
which on Android is a directory nothing writes.

- [ ] **Step 4: Mirror the union in TypeScript**

`src/lib/ipc.ts:3155`:

```ts
export type InstallKind = "portable" | "nsis" | "managed" | "other";
```

Keep the `Mirrors `update::InstallKind`` doc comment three lines above it and extend it:

```ts
/**
 * Mirrors `update::InstallKind`.
 *
 * `managed` is Android: the Play Store installed this app and the store is what replaces it.
 * It is deliberately **not** `other` — `other` means "we could not tell, here is the release
 * page", and this app's release page offers a Windows exe and an NSIS installer, which is a
 * worse answer on a phone than no answer.
 */
```

- [ ] **Step 5: Say it in the panel**

`src/features/settings/UpdatePanel.tsx` renders from `update.status.installKind`. Find how it
branches — `grep -n "installKind" src/features/settings/UpdatePanel.tsx` returned **nothing** when
this plan was written, so **the panel does not currently read the field at all**. Read the
component and decide where the sentence goes; the copy is:

> **Updates arrive through Google Play.** This build cannot replace itself, and there is
> nothing to check for here.

and the Check-now button, the download progress and the release list are all hidden behind
`installKind !== "managed"`.

**This step is a read-then-decide, not a paste.** The panel's shape is not knowable from this
plan and inventing its JSX here would be a placeholder.

- [ ] **Step 6: Run the tests**

```bash
cd src-tauri && cargo test update:: 2>&1 | tail -12
cd .. && npx vitest run src/features/settings/UpdatePanel.test.tsx 2>&1 | tail -12
```

Both counts must move up. Name them.

- [ ] **Step 7: Mutate to prove the wire-name test bites**

Change `Managed`'s serde name — add `#[serde(rename = "play")]` to the variant. Run
`cargo test managed_serialises`; it must **FAIL**. Revert.

That test is the only thing standing between a Rust rename and a TS union that silently stops
matching, which renders as a panel with no branch taken.

- [ ] **Step 8: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/update.rs src-tauri/src/lib.rs src/lib/ipc.ts \
        src/features/settings/UpdatePanel.tsx src/features/settings/UpdatePanel.test.tsx
git commit -m "feat(android): a fourth InstallKind, because the store owns the update

InstallKind::Other already means 'we could not tell, here is the release page' — and this
repo's release page offers a Windows exe and an NSIS installer, which is a worse answer on a
phone than none. Managed means 'something else installs this app', which is true, is typed,
and makes the TypeScript union exhaustive so UpdatePanel cannot forget the case.

Updater::new decides it from cfg!(mobile) before touching the disk, so the write probe
detect_install_kind runs beside the executable is never attempted in a native-library
directory. The daily check is not spawned there either: it would spend a GitHub request and an
app_meta row to learn something the app cannot act on."
```

- [ ] **Step 9: STOP AND REPORT — the release story**

Do not attempt any of the following. Report that they are needed and what each costs:

1. **A Google Play developer account** — a one-time fee, a legal identity, and a verification
   process. Markus's, not an agent's.
2. **An upload keystore**, which is the one secret in this project that cannot be regenerated:
   lose it and the app can never be updated under the same listing again. Where it is stored and
   how it is backed up is a decision. Task 3's `.gitignore` already refuses to commit one.
3. **A `signingConfig` in `gen/android/app/build.gradle.kts`** reading a `keystore.properties`
   that is itself ignored.
4. **Whether `release.yml` learns to build an AAB.** It currently builds Windows artifacts and
   release-please cuts the tag; adding Android means an SDK and NDK on the runner, the keystore
   as a secret, and a decision about whether a Play upload is automated at all.
5. **A privacy policy and a data-safety declaration**, which Play requires. This app collects
   nothing and talks to Scryfall, Card Kingdom, Mana Pool, Commander Spellbook and GitHub —
   that list is the declaration's content and it should be written by whoever signs it.

**Ask through `AskUserQuestion`, with the costs in the option descriptions.**

---

### Task 8: First run on the phone, and the CDP harness

**Files:**
- Create: `scripts/android-devtools.ps1`
- Test: none — this task produces measurements, and they land in Task 9's reference doc.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: a documented, repeatable way to drive the app on the device, plus the first Android
  numbers this repo has.

> **The spike drove *Chrome* on the phone; this drives the *app's own WebView*, and they are not
> the same socket.** `spike/drive-android.mjs` connects to `chrome_devtools_remote`, which is
> Chrome-the-browser's. A Tauri app's WebView publishes a different abstract socket — the
> Android convention is `webview_devtools_remote_<pid>` — and **this plan does not assert the
> name**, because nobody has run this app on a phone. Step 3 discovers it.

- [ ] **Step 1: Claim the lock and install a debug build**

```powershell
pwsh -File .claude/skills/running-the-app/lock.ps1 claim app
$ADB = "C:\Users\Markus\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe"
$env:JAVA_HOME = "<Task 1's JDK>"; $env:ANDROID_HOME = "<Task 1's SDK>"; $env:NDK_HOME = "<Task 1's NDK>"
npm run tauri android dev
```

**`tauri android dev` runs `adb reverse` itself** — the literal string is in the CLI binary — so
the dev server reaches the phone as `http://localhost:1420`, which is a **secure context** and
matches `tauri.conf.json`'s `devCsp` character for character.

> ⚠️ **Do not set `TAURI_DEV_HOST`.** It makes the dev URL a LAN IP, and `devCsp` names
> `ws://localhost:1420 http://localhost:1420` literally — the page would refuse its own dev
> server and the symptom is a blank window with a CSP violation in a console nobody is watching
> yet, not a build error.

If `adb reverse` does not happen on its own, do it by hand and say so in the report:

```powershell
& $ADB reverse tcp:1420 tcp:1420
```

- [ ] **Step 2: Confirm the app is what is on screen**

```powershell
& $ADB shell dumpsys activity activities | Select-String "mResumedActivity"
& $ADB logcat -d -s RustStdoutStderr:* | Select-Object -Last 40
```

`RustStdoutStderr` is where Android sends this crate's `eprintln!`, which is how
`init_state`'s data-directory message, the sync's failures and the mirror's absence become
visible at all. **There is no console on a phone; logcat is it.**

- [ ] **Step 3: Find the DevTools socket, and do not guess its name**

```powershell
& $ADB shell "cat /proc/net/unix" | Select-String -Pattern "devtools"
```

Every abstract socket ending in `devtools_remote*` is listed there with a leading `@`. Take the
one whose suffix matches the app's pid:

```powershell
$pid = (& $ADB shell pidof com.mtggrimoire.app.debug).Trim()
& $ADB shell "cat /proc/net/unix" | Select-String -Pattern "devtools_remote"
```

**Record the exact name in the report.** It is `webview_devtools_remote_<pid>` by Android
convention, but this app has never been run there and the convention is not a measurement.

- [ ] **Step 4: Write `scripts/android-devtools.ps1`**

```powershell
# Forward the running app's WebView DevTools socket to a local port, so `scripts/cdp.mjs` can
# drive the phone exactly as it drives the desktop window.
#
# CDP_PORT 9444 rather than 9222: 9222 is the desktop app's, and 9223 is the MCP bridge's.
# Both are hardcoded elsewhere in this repo and must not be remapped, so this takes a fourth.
#
# The socket name is NOT hardcoded. Android names it after the process id, so it changes on
# every launch — a script with a fixed name works once and then silently forwards nothing,
# which reads as "the app is broken" rather than "the port moved".
param(
  [string]$Package = "com.mtggrimoire.app.debug",
  [int]$Port = 9444
)

$ErrorActionPreference = "Stop"
$adb = "C:\Users\Markus\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { Write-Error "adb not found at $adb"; exit 2 }

$socketLine = (& $adb shell "cat /proc/net/unix" | Select-String -Pattern "devtools_remote" | Select-Object -First 10)
if (-not $socketLine) {
  Write-Error "No devtools socket on the device. Is the app running, and is it a DEBUG build? A release WebView does not publish one unless setWebContentsDebuggingEnabled(true)."
  exit 3
}
Write-Host "sockets found:"; $socketLine | ForEach-Object { "  $_" }

# The app's own, matched by pid. `pidof` answers empty for a package that is not running.
$appPid = (& $adb shell pidof $Package).Trim()
if (-not $appPid) { Write-Error "$Package is not running on the device."; exit 4 }

$name = ($socketLine -join "`n" | Select-String -Pattern "([a-z_]+devtools_remote(_$appPid)?)" -AllMatches).Matches |
  Where-Object { $_.Value -like "*_$appPid" } | Select-Object -First 1 -ExpandProperty Value
if (-not $name) { Write-Error "No devtools socket matched pid $appPid. Sockets above; name one by hand."; exit 5 }

& $adb forward "tcp:$Port" "localabstract:$name"
Write-Host "forwarded tcp:$Port -> localabstract:$name"
Write-Host "now:  `$env:CDP_PORT = '$Port'; node scripts/cdp.mjs eval `"location.href`""
```

`scripts/cdp.mjs` already reads `CDP_PORT` (`scripts/cdp.mjs:32`), so **no change to the harness
is needed** — that was checked before this script was written.

> ⚠️ **`cdp.mjs` takes the first target of `type: "page"`.** On a phone that is very likely the
> only one, but if DevTools or a second WebView is attached it will silently answer about the
> wrong DOM and every probe will read as the feature being broken. Put `location.href` in the
> first payload of every pass.

- [ ] **Step 5: Drive it, and take the measurements**

```powershell
pwsh -File scripts/android-devtools.ps1
$env:CDP_PORT = "9444"
node scripts/cdp.mjs eval "(() => ({ href: location.href, ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))()"
```

Then, in order, and **recording every number with "debug build, OnePlus 12, optimistic bound"
attached**:

| What | How |
| --- | --- |
| **First sync end to end** | delete the app's data (`adb shell pm clear com.mtggrimoire.app.debug`), relaunch, and time from launch to the ribbon reporting done. Compare against the spike's **36.5 s** browser figure and desktop's **10.4 s** — this is native, so it should beat the browser one. |
| **FTS5 is really there** | `node scripts/cdp.mjs eval "…"` driving a search for `dragon`; a missing FTS5 is a zero-row answer, not an error |
| **The facet index warms** | `facet_cards` answering `ready: true`; time it against desktop's ~767 ms |
| **The collapsed browse** | spec §8 calls this the implementation-PR gate. It is 131.8 ms end-to-end on desktop. Take the Android number. |
| **Card images render** | one tile with real art — this proves `mtgimg://` resolves through `http://mtgimg.localhost` and the CSP allows it |
| **The database file and its journal** | `adb shell run-as com.mtggrimoire.app.debug ls -la files/data/` — the `mtg.db` size and, after an ingest, the `-wal`. `journal_size_limit` is 64 MB and this is where that gets checked rather than assumed. |
| **Where the data directory actually is** | the same `ls`, plus logcat. This is `paths::data_dir_for`'s mobile branch, live. |
| **The APK's installed footprint** | `adb shell pm path` + `du` |

- [ ] **Step 6: Drive the three pickers, because Task 5 is unverified until this happens**

The Rust in Task 5 was written against the plugin sources and has **never touched a real
ContentResolver**. All three need a human tap on the device — a picker is a system UI that CDP
cannot drive:

1. **Import** — Settings/Decks → import a decklist from Downloads. Must produce the same parse
   the desktop does for the same file.
2. **Export** — export a deck to a new file, then read it back with
   `adb shell content read --uri <the uri from logcat>` or by pulling it out of Downloads.
3. **Deck cover** — pick a photo. Must land as a 626×457 WEBP.

**A failure in any of these is Task 5's `OpenOptions` shape or the `url::Url` route, and it is a
stop-and-report** — both were flagged as unverified in that task for exactly this moment.

- [ ] **Step 7: Check the two things that only a phone can be wrong about**

**a. Does the process ever get `RunEvent::Exit`?** `checkpoint_on_exit` folds the WAL back on
the way out, and `tauri::RunEvent` (checked in `tauri-2.11.5/src/app.rs:220`) has **no `Paused`
or `Suspended` variant** — so on a phone, which kills processes rather than exiting them, that
handler may simply never run. Test it: put the app in the background, `adb shell am kill
com.mtggrimoire.app.debug`, then `ls -la files/data/`. If the `-wal` survives at up to 64 MB,
that is the designed floor and costs disk rather than data. **If it is larger than 64 MB, the
`journal_size_limit` is not doing what desktop measured and that is a finding.**

**b. Does the MCP bridge open a socket on the phone?** It is registered under
`#[cfg(debug_assertions)]` and a `tauri android dev` build is a debug build.
`capabilities/mobile.json` denies its three commands, but the *socket* is opened in Rust, not
through the ACL. Check:

```powershell
& $ADB shell "cat /proc/net/tcp" | Select-String "2407"   # 9223 in hex
```

**If it is listening, that is a finding and needs a `#[cfg(desktop)]` on the bridge's
registration** — an unauthenticated WebSocket that evaluates arbitrary JavaScript, on a device
that joins other people's networks, is not the same risk it is on this workstation's loopback.

- [ ] **Step 8: Release the lock and report**

```powershell
pwsh -File .claude/skills/running-the-app/lock.ps1 release app
```

Report every number from Steps 5 and 7, the socket name from Step 3, and the outcome of each of
Step 6's three pickers. **Say plainly which parity-matrix Android cells this run confirmed and
which it did not** — Task 9 writes them down either way.

- [ ] **Step 9: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add scripts/android-devtools.ps1
git commit -m "chore(android): forward the app's WebView DevTools socket to cdp.mjs

scripts/cdp.mjs already reads CDP_PORT, so the desktop harness drives the phone unchanged
once the socket is forwarded. Port 9444 because 9222 is the desktop app's and 9223 is the MCP
bridge's, and both are hardcoded in tracked files.

The socket name is discovered rather than hardcoded: Android names it after the process id, so
a fixed name works once and then silently forwards nothing — which reads as a broken app
rather than a moved port. The script also refuses early when the package is not running,
because `adb forward` succeeds against a socket that does not exist."
```

> ⚠️ **`scripts/*` routes to the `frontend` CI job** (`eslint .` lints that directory), but a
> `.ps1` routes to `powershell` — the `*.ps1` arm sits above `scripts/*` in `ci.yml` and is
> first-match-wins. So this file will run the PowerShell job, which runs `lock.test.ps1` and
> `pr-auto.test.ps1` and knows nothing about this script. That is correct and cheap; it is not
> a gap to fill.

---

### Task 9: The record

**Files:**
- Create: `docs/reference/android-target.md`
- Modify: `CLAUDE.md` — one row in the reference table
- Modify: `src-tauri/CLAUDE.md` — a section under "Tauri capabilities"
- Modify: `src/CLAUDE.md` — one line about `src/lib/platform.ts`
- Modify: `docs/superpowers/specs/2026-08-27-cross-platform-parity-matrix.md` — the cells this PR
  proved and the ones it could not

- [ ] **Step 1: Write `docs/reference/android-target.md`**

It must hold, with the date and the build on every figure:

1. **The toolchain, exactly** — the JDK that works and the one that does not, the SDK and NDK
   revisions, `ANDROID_HOME`/`NDK_HOME` as the two names the CLI reads, the four Rust targets,
   and `npx tauri` rather than `cargo tauri`. Task 1's report is the source.
2. **What is gated and why**, split into "cannot compile" and "must not run", with the file and
   line of each tauri `#[cfg(desktop)]` that forced it. **State plainly that `mirror/`,
   `transfer/` and `update.rs` still compile on Android and why that is not a violation of spec
   §6.3.**
3. **The `content://` seam.** The Kotlin intents, `FilePath::Url`, `Fs::open`'s fd, and the
   paragraph on why no `fs:` permission is granted.
4. **The verification recipe** — `adb reverse`, never `TAURI_DEV_HOST`, the socket discovery,
   `CDP_PORT=9444`, `logcat -s RustStdoutStderr`.
5. **Every measurement from Task 8**, each labelled "OnePlus 12, debug build, an optimistic
   bound", beside the desktop figure it compares to.
6. **What is still open**, which after this PR includes at least: the Play release (Task 7's
   stop gate), the mobile layout (PR 9), touch dragging (PR 3), and every parity-matrix cell
   Task 8 could not confirm.

- [ ] **Step 2: Add the row to the root `CLAUDE.md` reference table**

Alphabetical position is not the table's order — it is grouped by area. Put it after
`in-app-updates.md`:

```markdown
| [android-target.md](docs/reference/android-target.md) | The Android build — the toolchain and what it cost, what is gated and what merely never runs, the `content://` file seam, and every figure taken on the phone |
```

- [ ] **Step 3: Add the section to `src-tauri/CLAUDE.md`**

Under "Tauri capabilities", after the snap-layout paragraph. It must carry, as hard rules:

- **`capabilities/` is two files and `platforms` is why.** Naming the three verbs tauri does not
  ship on Android, and the four absences from `mobile.json` with their reasons.
- **`tauri-plugin-fs` is a dependency with no permission, deliberately.** The ACL gates the
  webview; `Fs::open` is Rust-side. A future edit that grants an `fs:` entry is the thing this
  paragraph exists to stop.
- **Android is native and the wasm constraints are Web's.** One sentence, because it is the fact
  most easily lost.
- **`cfg(desktop)` / `cfg(mobile)` are real cfgs**, emitted by `tauri_build::build()`
  (`tauri-build/src/lib.rs:476`), and cargo checks them.

- [ ] **Step 4: One line in `src/CLAUDE.md`**

Beside whatever it says about `src/lib/images.ts`:

```markdown
- **`src/lib/platform.ts` is the only place the page asks what platform it is on**, and it asks
  the user agent — `images.ts`'s shipped precedent. It answers `false` for anything it does not
  recognise, which is what keeps jsdom and Storybook on the desktop shape. Two surfaces read it:
  `AppShell` (no caption on Android) and `SettingsPage` (no Backup panel). A third reader is a
  reason to re-open whether this belongs behind Boundary A instead.
```

- [ ] **Step 5: Correct the parity matrix, in place**

The Android column has cells this PR proved, cells it disproved, and cells it could not reach.
Edit them with the evidence and the date. **At minimum:**

- §5's `plugin-dialog` row — "Tauri mobile dialog" is true and incomplete; it answers a
  `content://` URI, and `picked.rs` is what makes that work.
- §5's `mtgimg://` row — the matrix says "Tauri asset protocol"; the app registers a **custom URI
  scheme protocol**, and `imageOrigin()` already returns `http://mtgimg.localhost` for Android.
  Correct the mechanism name.
- §6's "Two windows / tabs at once | ✅" for Android — **there is no evidence for this and it is
  very likely wrong.** Android runs one task per application, and `tauri-plugin-single-instance`
  does not exist there at all. Replace with the measured behaviour or mark it open.
- §6's "Image cache | 🟡 256 MB LRU" for Android — the 256 MB number is derived in spec §5.4 from
  *browser eviction* and a 1 GB web footprint ceiling, neither of which applies to a native app
  with a real filesystem. **No measurement supports it on Android.** Say so, and note that the
  cap there is about phone storage and is a different argument.
- §6's "Updates | Play Store" — now `InstallKind::Managed` in the app, and a stop gate outside
  it.
- §1's "Collapsed / uncollapsed browse | ✅" for Android — replace the ✅ with Task 8's number.
- §2's four feed rows for Android — replace "unmeasured" with whatever Task 8 measured, and leave
  the rest explicitly unmeasured rather than ✅.

- [ ] **Step 6: Verify the prose against the tree, because nothing else will**

**A prose-only edit routes to neither CI job.** Before committing, re-check every count, file
path and line reference this task wrote:

```bash
grep -n "cfg(desktop)" src-tauri/src/lib.rs | wc -l     # against whatever the doc claims
ls src-tauri/capabilities/                              # two files, no default.json
grep -rn "fs:" src-tauri/capabilities/                  # must be empty
```

**Better still, do not write down a number a build already answers.** The root `CLAUDE.md`
records that the Storybook totals were deleted for conflicting on five consecutive merges.

- [ ] **Step 7: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add docs/reference/android-target.md CLAUDE.md src-tauri/CLAUDE.md src/CLAUDE.md \
        docs/superpowers/specs/2026-08-27-cross-platform-parity-matrix.md
git commit -m "docs(android): the record, and the parity matrix corrected where it was guessing

android-target.md carries the toolchain as it actually is on this machine, the two-way split
between what cannot compile and what merely must not run, the content:// file seam, and every
figure from the device labelled as the optimistic bound a flagship gives.

Five cells in the matrix's Android column had no evidence behind them and now say so. The one
worth naming: 'two windows at once' was marked full parity for Android, where the platform runs
one task per application and tauri-plugin-single-instance does not compile at all."
```

---

## Self-Review

**Spec coverage.** This plan implements spec §10's PR 8 in full: the mobile target's
configuration (Task 3), the plugins that need Android equivalents (Tasks 4 and 5 — `dialog` for
all four file-picking components, `clipboard-manager` and `opener` verified as already
sufficient), what is compiled out or made unreachable per §6.3 (Task 2 for `window.rs` and the
mirror's thread, Task 7 for the portable swap), updates going through Play (Task 7), and the
verification story of §9 (Task 8). It does **not** implement mobile layout (§6.1, PR 9) or the
`@dnd-kit/react` migration (§6.4, PR 3), both of which the spec places elsewhere.

**Placeholders.** None. Six steps are deliberately *read-then-decide* rather than paste — Task 5
Step 5's `export::tests` restructuring, Task 5's `OpenOptions` builder, Task 6 Step 5's panel
location, Task 7 Step 3's `classify_managed` shape, Task 7 Step 5's `UpdatePanel` copy, and Task 9
Step 5's matrix edits. Each says explicitly what to read and why the plan does not name the code:
in every case the source is the authority and inventing it here would be exactly the "confident
step over an unknown" that Phase 1's plans carried ten of.

**Mutation coverage.** Tasks 2, 3, 4, 5, 6 and 7 each carry a mutation step naming the exact
edit and the exact test that must go red. Tasks 1, 8 and 9 cannot be mutated — an install, a
device run and a prose edit — and each carries a named falsifier instead: a command whose output
would prove the step did not do what it claims.

**Ordering.** Task 1 gates everything and stops. Task 2 must precede Task 3 (`android init` runs a
cargo build). Task 4 must follow Task 3 (the Android schema is generated there). Task 5 must
follow Task 4 (its test asserts the absence of an `fs:` grant). Tasks 6 and 7 are independent of
each other and of 5, and could be fanned out to parallel subagents — 6 touches only
`src/lib/platform.ts`, `AppShell.tsx` and `SettingsPage.tsx`; 7 touches `update.rs`, `ipc.ts` and
`UpdatePanel.tsx`. **Both edit `src-tauri/src/lib.rs`**, so if they are run in parallel they must
be in separate worktrees or one of them must be given the `lib.rs` hunk.

**Type consistency.** `picked::open_read(&AppHandle, &str) -> Result<Box<dyn Read + Send>, String>`
and `picked::write_all(&AppHandle, &str, &[u8]) -> Result<(), String>` are called with exactly
those signatures in `import.rs`, `export.rs` and `images.rs`.
`paths::data_dir_for(Option<&Path>, &Path, bool) -> PathBuf` is called once, from `init_state`,
with `exe_dir.as_deref()`. `isAndroid(userAgent?: string): boolean` is called with no argument at
both use sites and with a string in every test.

**Three things were checked against the source rather than assumed, and the plan would have been
wrong about all three:**

- **`cargo-tauri` is not installed on this machine.** The brief says it is, version 2.11.4 — that
  version is the **npm** `@tauri-apps/cli`. `cargo tauri --version` exits 101 with
  `error: no such command`. Every command in this plan is `npx tauri` or `npm run tauri`.
- **The Adoptium Java on `PATH` is a JRE, not a JDK.** So the obvious escape from the JDK 25
  problem — "point `JAVA_HOME` at the 21 that is already here" — does not exist. A JDK must be
  installed, which is why Task 1's stop gate exists rather than a one-line `$env:JAVA_HOME`.
- **`update.rs` and `mirror/` cannot be `cfg`'d out**, which a plain reading of spec §6.3 would
  have had this plan attempt. `get_app_meta`/`set_app_meta` have callers in a dozen modules and
  `AppState` carries two mirror types constructed at six sites including test fixtures.

**What this plan knows it does not know**, each with a task that finds out and a gate that stops:

| Unknown | Where it is settled |
| --- | --- |
| Whether JDK 25 works with Gradle 8.14.3 and KGP 1.9.25 | Task 1 Steps 2 and 8 — predicted no, measured either way |
| What the SDK + NDK cost in disk, and whether a licence needs accepting | Task 1 Steps 3 and 7 |
| Whether `rusqlite`'s `bundled` C build works against the NDK | Task 1 Step 5 — the single riskiest compile, moved to the front |
| Whether there is a fourth compile break beyond the three named | Task 2 Step 7 — an explicit stop-and-report |
| What the generated Gradle project actually pins, and which permissions its manifest asks for | Task 3 Step 2 |
| The exact shape of `tauri_plugin_fs::OpenOptions` and whether `FilePath` parses from a `&str` | Task 5 Step 3's warning box, confirmed on the device in Task 8 Step 6 |
| Whether the three pickers work against a real ContentResolver | Task 8 Step 6 — untestable anywhere but on the phone |
| The DevTools socket's real name | Task 8 Step 3 — discovered, not asserted |
| Whether `RunEvent::Exit` ever fires on Android, and how large the `-wal` gets | Task 8 Step 7a |
| Whether the MCP bridge opens a socket on the phone | Task 8 Step 7b — a finding if it does |
| Everything about a Play release | Task 7 Step 9 — a stop gate, and none of it an agent's work |
