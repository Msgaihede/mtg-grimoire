# In-app updates

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **`tauri-plugin-updater` is deliberately NOT used, and cannot be.** It updates a Windows
  app by downloading and running its _installer_, and has no path for replacing a bare
  portable exe — pointing it at one installs a **second** copy into Program Files and leaves
  the portable copy and its `data/` behind. So the updater is hand-written.
- What that gives up is minisign. What is left is measured: **every GitHub release asset
  carries a `digest`** (`sha256:…`, all five). An asset with no digest is **refused**, never
  installed-unverified. **The digest proves integrity and not origin**: GitHub computes it for
  whoever uploads the file, so it says the bytes arrived as they were uploaded and nothing about
  who uploaded them. Anyone who can write to this repository's releases can ship an update.
- **Update signing was built and removed, and this is the record** (2026-09-28 → 2026-09-29).
  [#653](https://github.com/Msgaihede/mtg-grimoire/pull/653) (issue #545) added a minisign
  check to the updater (`ac226e51`), a compiled-in public key (`4175c91a`, key id
  `FD103A4C389F00B0`) and a `sign` job in `release.yml` (`8a5568d6`) that failed closed without
  the `UPDATE_SIGNING_KEY` repository secret. The secret was never set, so the first release
  after it — **v0.34.0** — stopped at `sign` and stayed a draft. The check, the key, the job,
  `scripts/update-signing.mjs` and its fixtures were then removed on the maintainer's decision.
  Two things to know before anyone brings it back:
  - **The v0.34.0 draft must never be published.** Its binaries were built with the check and
    that key, so every install of it would refuse any update not signed by `FD103A4C389F00B0`,
    for good. The next release is built from the removal.
  - **No signing *service* is involved** — the pair is made locally by a script, and the secret
    is a repository secret. Reinstating it is `git revert` of the removal plus a fresh key; the
    order rule (the key ships in a release before anything is signed with it) is in the removed
    commit's copy of this file.
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
- **The check can run where the download cannot.** `pick_asset` answers `None` for `Other`, so
  an install that cannot replace itself still checks, still caches the notes and the history,
  and is offered the release page rather than a download it cannot make. The web and Android
  builds, which checked the same way through their own glue, were removed on 2026-09-27.
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
  the update looks corrupt. ⚠️ **Since 2026-09-20 that failure wears a different face**: the
  predecessor answers a second launch by opening a window
  ([multi-window.md](multi-window.md)), so a successor that raced it would leave the reader with
  a window of the **old** build looking like the update had worked. The wait is what makes both
  readings moot, and it has not changed. **The first version waited by deleting the renamed image and that
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
- **Installing ends every window, and past one the button says so** (2026-09-20). `update_apply`
  calls `app.exit(0)`, which is the *process* — so when `useWindowCount() >= 2` the panel draws
  *Restarting closes all N windows.* under **Restart to finish**, as an `aria-describedby` hint
  rather than a dialog: that button is already the second, deliberate press. One window comes back
  after the restart, and restoring the rest is out of scope.
- NSIS handoff is `setup.exe /P /R /UPDATE`, **spawned before we exit**: the installer's
  `CheckIfAppIsRunning` kills the running process without prompting in passive mode, and
  leaving on our own terms is what lets `RunEvent::Exit` checkpoint the WAL.
- **Every launch empties `data/updates/` of files, and until 2026-09-28 nothing did**
  ([issue #551](https://github.com/Msgaihede/mtg-grimoire/issues/551)). The folder holds the NSIS
  setup a download staged and the `.part` of one that failed; `update::clean_up` cleared only the
  `.old` and `.new` beside the exe, so every NSIS update left its whole installer on disk for good.
  Staging lives for one session by design, so anything in that folder at a launch is spent. A failed
  portable extraction now deletes its `.part` and its half-written `.new` at once
  (`update::stage_portable`).
- **The staged `.new` and a downloaded setup are `sync_all`'d before they are used**, not only
  flushed. `apply` renames the `.new` over the running exe, and a rename can reach the disk before
  the data it names — a power cut between them would leave a zero-length `mtg-grimoire.exe`, the one
  state a portable install cannot recover from by itself. Nobody has measured the cost; it is one
  flush of a single-digit-megabyte file.
- Schema **v6** adds `app_meta` for the check throttle and the cached release — not
  `sync_meta`, which belongs to the sync. The version history is a **third key in that same
  table** and needed no migration, `marketplace` and `printing_group_by`'s precedent.
- `MTG_GRIMOIRE_UPDATE_API` re-points the check at a local release fixture and is
  `#[cfg(debug_assertions)]` — compiled out of a release build entirely. It is the only way to
  exercise download → verify → swap → relaunch for real.
