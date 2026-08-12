# In-app updates

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **`tauri-plugin-updater` is deliberately NOT used, and cannot be.** It updates a Windows
  app by downloading and running its _installer_, and has no path for replacing a bare
  portable exe — pointing it at one installs a **second** copy into Program Files and leaves
  the portable copy and its `data/` behind. So the updater is hand-written.
- What that gives up is minisign. What replaces it is measured: **every GitHub release asset
  carries a `digest`** (`sha256:…`, all five). An asset with no digest is **refused**, never
  installed-unverified. `/releases/latest` also excludes drafts and prereleases by
  construction, which is exactly what `releaseDraft: true` needs. **`release.yml` did not
  change at all.**
- Asset selection is a **suffix** match (`-windows-x64-portable.zip`, `_x64-setup.exe`), never
  a literal name — v0.2.0's assets still carry the app's former product name. `content_type`
  is `application/zip` on **all five**, the `.exe`, `.msi` and `.deb` included, so it
  discriminates nothing.
- Install kind is decided once at startup: `<exe dir>\uninstall.exe` → **NSIS**; else a
  _probed_ writable exe dir → **portable**; else **other**. An MSI install and every Linux
  build land on `other` and get the release page — an MSI major upgrade is unverified and
  nobody has ever run a Linux build.
- **The portable swap: rename the running exe aside, never overwrite it.** Windows permits
  renaming a running image and refuses to replace one. If the second rename fails the first is
  undone, so a failure leaves a working app.
- **The successor waits on the predecessor's process handle** (`--await-predecessor <pid>`,
  `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject`), _before_ `Builder::default()`. Without
  the wait `tauri-plugin-single-instance` gives it **exit code 0, no window, no stderr** and
  the update looks corrupt. **The first version waited by deleting the renamed image and that
  was wrong**: Rust's `fs::remove_file` uses POSIX-semantics deletion on current Windows, so
  it _succeeds_ against a running exe — measured as "let go after 0 ms" with 200 ms of
  predecessor still to live. With the process wait: **231 ms**, window back, PID changed.
  `update::tests::deleting_a_file_that_is_still_open_succeeds_on_windows` pins the false
  premise.
- **A command must not build its answer while holding its own busy guard.** `status` reports
  `busy` by reading that flag, so `check`/`download` returning inside the guard tell the UI
  the operation is still running and the panel disables the button it just earned. Measured:
  "Restart to finish" arrived already disabled. Every `Ok` path drops the guard first. Invisible
  to unit tests, which pass `busy` in by hand.
- NSIS handoff is `setup.exe /P /R /UPDATE`, **spawned before we exit**: the installer's
  `CheckIfAppIsRunning` kills the running process without prompting in passive mode, and
  leaving on our own terms is what lets `RunEvent::Exit` checkpoint the WAL.
- Schema **v6** adds `app_meta` for the check throttle and the cached release — not
  `sync_meta`, which belongs to the sync.
- `MTG_GRIMOIRE_UPDATE_API` re-points the check at a local release fixture and is
  `#[cfg(debug_assertions)]` — compiled out of a release build entirely. It is the only way to
  exercise download → verify → swap → relaunch for real.
