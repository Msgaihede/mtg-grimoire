# In-app updates

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **`tauri-plugin-updater` is deliberately NOT used, and cannot be.** It updates a Windows
  app by downloading and running its _installer_, and has no path for replacing a bare
  portable exe — pointing it at one installs a **second** copy into Program Files and leaves
  the portable copy and its `data/` behind. So the updater is hand-written.
- What that gives up is minisign. What replaces it is measured: **every GitHub release asset
  carries a `digest`** (`sha256:…`, all five). An asset with no digest is **refused**, never
  installed-unverified. **`release.yml` did not change at all.**
- **The check reads `/repos/<repo>/releases?per_page=30`, and one request answers two
  questions** (2026-08-17): the newest release the app might move to, and the version history
  the settings panel draws. It replaced `/releases/latest`, whose answer was a strict subset —
  a second endpoint for the history would have spent a second request out of the 60/hour per
  IP to fetch a superset of what the first already returned. Three things moved with it, each
  small and each easy to get wrong:
  - **Drafts and prereleases are filtered in Rust now.** `/releases/latest` applied exactly
    that filter server-side, which is what `releaseDraft: true` needs; `parse_release_page`
    applies it to both answers at once, so the history and the offer cannot disagree about
    which releases exist.
  - **"Latest" is the first entry, not the highest version.** GitHub defines its latest release
    by `created_at` and orders `/releases` by the same key, so taking `.first()` is parity
    rather than laziness — and `is_newer` is what decides whether the answer is an update.
  - **An empty repository answers `200 []` here where it answered `404` before.** Both arms
    survive and both clear the two cached keys; a check that learned nothing must not leave
    yesterday's history standing under a freshly stamped `lastCheckAt`.
- **`update_history` reads a row and never the network.** The page the check cached lands in
  `app_meta.update_release_history` as `Vec<ReleaseNote>` — `ReleaseInfo` minus its assets,
  because thirty releases' worth of asset URLs and 64-character digests is not something a
  changelog can use. Expanding a release in Settings therefore costs nothing out of GitHub's
  budget, and an install that has never checked answers `[]` rather than an error.
- **The release body is stored verbatim and read in TypeScript.** `src/lib/releaseNotes.ts` is
  a reader for release-please's output rather than a markdown parser: the vocabulary is closed
  (a version heading, `### Features`/`### Bug Fixes`, `* **scope:** …` bullets with a commit
  trailer, the occasional hand-written paragraph), and **anything it has no rule for falls
  through to a paragraph and is drawn as written**. That fallback is what answers the old
  panel's argument — *"half-rendered markdown reads worse than none"* — instead of abandoning
  it: the worst case is exactly what the `<pre>` used to give. A dependency was not an option
  either way, since the shipped CSP is `script-src 'self'` and there is no
  `dangerouslySetInnerHTML` anywhere in `src/`. Three display decisions live there and nowhere
  else: the leading version heading is dropped (the row above already says the version and the
  date), the commit trailer is stripped, and identical bullets collapse — release-please writes
  one message twice when it lands on two branches, which is what v0.9.1's changelog shows.
  Only an `https:` link becomes an anchor; anything else keeps its words and loses its link,
  the webview's end of the fence `update_open_release_page` already applies in Rust.
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
  `sync_meta`, which belongs to the sync. The version history is a **third key in that same
  table** and needed no migration, `marketplace` and `printing_group_by`'s precedent.
- `MTG_GRIMOIRE_UPDATE_API` re-points the check at a local release fixture and is
  `#[cfg(debug_assertions)]` — compiled out of a release build entirely. It is the only way to
  exercise download → verify → swap → relaunch for real.
