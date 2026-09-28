# In-app updates

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **`tauri-plugin-updater` is deliberately NOT used, and cannot be.** It updates a Windows
  app by downloading and running its _installer_, and has no path for replacing a bare
  portable exe — pointing it at one installs a **second** copy into Program Files and leaves
  the portable copy and its `data/` behind. So the updater is hand-written.
- **Every update is minisign-signed, and the updater verifies it before it unpacks or stages
  anything** (2026-09-28, issue #545). This bullet used to say the plugin's minisign was given
  up and that GitHub's upload **`digest`** replaced it. It did not: the digest (`sha256:…`, on
  all five assets, measured 2026-08-09) says the bytes arrived as they were uploaded, and GitHub
  computes one for whatever is uploaded — so a hijacked action tag in `release.yml`, or any
  leaked token with write access, could put a trojaned `*-portable.zip` on a release and every
  portable install would have checked its "valid" digest and swapped it in. The digest is still
  checked, first, as a transport check (`verify_digest`); **who published the file is the
  signature's question** (`verify_signature`).
  - **What is signed**: the two files the updater installs — the portable zip and the NSIS
    `_x64-setup.exe` (an executable it runs, with the same trust problem). The signature is the
    asset **`<asset name>.minisig`** on the same release, found by exact name, so `pick_asset`'s
    suffix match can never take a signature for the download. The `.msi`, `.deb` and `.AppImage`
    are not signed; nothing in the app installs them.
  - **Real minisign, prehashed**: `ED`, Ed25519 over BLAKE2b-512 of the file, plus the global
    signature over the signature and the trusted comment — `minisign -Vm` reads it. The legacy
    un-prehashed `Ed` form is refused however valid (`verify_stream` has no legacy mode, which is
    `allow_legacy = false` with no flag to get wrong). Verified by `minisign-verify` 0.3 —
    zero dependencies, and no `unsafe` since 0.3.0, whose `lib.rs` is byte-identical to 0.2.5's.
    The file is **read back from disk** in 64 KiB chunks rather than hashed as it streamed in, so
    what is verified is exactly what `extract_portable_exe` then opens.
  - **The trusted comment binds a signature to one release and one install kind**: it must be
    exactly `mtg-grimoire <version> <kind>`, `kind` `portable` or `nsis`, `<version>` being the
    release's `tag_name` without its `v`. The global signature covers it, so it cannot be edited
    without the key — and requiring it to match is what stops somebody who can upload but not
    sign from **replaying an older release's validly signed build onto a newer release** (a
    downgrade to a known hole) or the setup's signature beside the zip. It is compared only after
    the signature verifies, so the sentence naming another release is said only about a signature
    that really is ours.
  - **Fail closed, every way**: no `.minisig` beside the asset (refused before a byte is
    fetched), a signature that will not parse or is longer than 4 KiB, another key's id, a bad
    signature, the legacy form, the wrong trusted comment — each is a sentence in the Settings
    panel ending *Download it from the release page instead.*, the partial download is deleted,
    and nothing is extracted or staged. So is an asset with no digest, as before.
  - **The key is compiled in** — `update::SIGNING_PUBLIC_KEY`, minisign's base64 line — and a
    build trusts that key and no other. ⚠️ **It is a placeholder until the production keypair is
    generated**, and the placeholder is not a key: a build carrying it refuses every download
    (`a_build_without_a_key_refuses_every_download_before_fetching_it`), and a **release** build
    does not compile at all — a `const` assertion, `#[cfg(not(debug_assertions))]`, requires 56
    characters starting `RW`. Debug builds and tests are unaffected; the tests pass a throwaway
    key of their own.
  - **Signing is `scripts/update-signing.mjs`**, `node:crypto` and `node:fs` and nothing else:
    `keygen <secret-out-path>` writes the secret (mode 0600, never overwriting a file, never
    printed) and prints the public key; `sign <file> --trusted-comment <text>` reads the secret
    from `UPDATE_SIGNING_KEY` and writes `<file>.minisig`, refusing when the variable is empty.
    The secret is this script's own format — one base64 line of `keyid(8) || seed(32)` — not
    minisign's scrypt-wrapped file. It runs in `release.yml`'s **`sign` job**, never the build
    job; [ci-and-releases.md](ci-and-releases.md) has why.
  - **The fence between the two languages is one set of committed files**,
    `src-tauri/tests/fixtures/update-signing/`: a zip, a setup, their signatures and three hostile
    ones, made by the script with a **throwaway test key whose secret is committed on purpose and
    which nothing trusts**. `update::tests` verifies all of them — over HTTP through
    `download_signed`, for the staging and the refusals — and `scripts/update-signing.test.mjs`
    re-signs the same bytes and asserts **byte equality**; Ed25519 is deterministic, so the Node
    signer cannot drift from what the Rust verifier was proven against without one suite going
    red.
  - **What a signature proves, and what it does not.** It proves the file went through this
    repository's `sign` job with the repository's secret. It does **not** prove the build leg
    that produced the file was clean: the `sign` job signs what the draft holds, and a build leg
    compromised during the release run could upload before it signs. SHA-pinned actions shrink
    that; nothing here closes it. What the separate job does guarantee is that such a compromise
    cannot walk away with the key.
- **Setting up signing, once — and rotating the key.** The order matters because a build only
  ever trusts the key compiled into it, and the release that ships a new key is verified by
  installs that do not have it yet.
  1. `node scripts/update-signing.mjs keygen <path outside the repo>`. Stdout is the two lines of
     a minisign `.pub` file; the second is the key.
  2. Put that line into `SIGNING_PUBLIC_KEY` in `src-tauri/src/update.rs` (the one line reading
     `pub const SIGNING_PUBLIC_KEY: &str = "…";`) and merge it.
  3. Set the repository secret **`UPDATE_SIGNING_KEY`** to the secret file's one line
     (`gh secret set UPDATE_SIGNING_KEY < <path>`), and keep the file somewhere safe that is not
     this repository. Without it the `sign` job fails and every release stays a draft.
  - **The first time, both halves must land before the next release is cut** — a release build
    carrying the placeholder does not compile, and a release with no secret stays a draft — but
    their order between themselves is free: every install built before this change verifies no
    signature at all, so the release that introduces the key is installed by digest alone, and
    the release after it is the first that is verified.
  - **A rotation takes effect one release late, and the old secret keeps signing until then.**
    Release *N* carries the new public key but is still installed by builds that trust the old
    one, so *N* is signed with the **old** secret; only once *N* is out does `UPDATE_SIGNING_KEY`
    change, and *N + 1* is the first signed with the new key. An install that has not reached *N*
    by then is offered *N + 1* — the updater offers only the latest release — cannot verify it,
    and is sent to the release page. That is the price of a rotation, and why it is for a key
    believed compromised rather than a routine.
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
- Schema **v6** adds `app_meta` for the check throttle and the cached release — not
  `sync_meta`, which belongs to the sync. The version history is a **third key in that same
  table** and needed no migration, `marketplace` and `printing_group_by`'s precedent.
- `MTG_GRIMOIRE_UPDATE_API` re-points the check at a local release fixture and is
  `#[cfg(debug_assertions)]` — compiled out of a release build entirely. It is the only way to
  exercise download → verify → swap → relaunch for real. **A fixture release now needs a
  `.minisig` beside its asset, signed by the key the debug build compiles in** — which is the
  placeholder until the production key lands, so until then a live pass stops at the signature
  with the "no key" sentence; that refusal is the designed behaviour, not a broken fixture.
