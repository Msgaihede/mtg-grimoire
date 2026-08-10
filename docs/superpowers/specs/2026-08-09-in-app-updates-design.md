# In-app updates from GitHub Releases

**Date:** 2026-08-09
**Status:** approved, implementing

The app publishes every release to GitHub with its binaries attached. This makes the app
read that same feed, tell the user when a newer version exists, and — for the two Windows
distributions where it can be done honestly — install it without leaving the window.

## Why not `tauri-plugin-updater`

The official plugin updates a Windows app by **downloading and running its installer**
(`.nsis.zip` / `.msi.zip`). It has no path for replacing a bare portable exe, and the
stack-eval research already recorded the consequence: *"Breaks: … the updater (it downloads
the MSI)."*

The portable zip is not a side artifact here. CLAUDE.md calls it *"the behaviour no Program
Files install can reach"* — it runs from any folder and keeps `data/` beside itself. Pointing
the plugin at a portable copy would install a **second** app into Program Files and leave the
portable one, and its collection, untouched and stale.

So the updater is hand-written. What that costs — no minisign signature — is bought back by a
fact measured against the live API on 2026-08-09: **every release asset carries a `digest`
field** (`sha256:…`, populated on all five). That is a real integrity check that needs no
keypair, no CI secret and no change to `release.yml`.

## What the user sees

Three states, none of which ever covers the app.

1. **Nothing found** — the ribbon is unchanged.
2. **Update available** — a gold-outlined `Update to 0.3.0` button appears in the ribbon,
   left of Refresh. It switches to Settings.
3. **Settings → Updates** — current version, new version, published date, release notes, and
   one primary button whose label is the state machine.

| Install kind | Button sequence | Terminal action |
|---|---|---|
| Portable | `Download 6.4 MB` → progress → `Restart to finish` | swap the exe, relaunch |
| NSIS     | `Download 4.8 MB` → progress → `Restart to finish` | hand off to the setup |
| MSI / Linux / unknown | `Open release page` | `tauri-plugin-opener` |

Settings also carries `Check now` and a "last checked" line — a daily throttle with no way to
see it is indistinguishable from a broken check.

**The webview never touches the network.** The GitHub call is Rust, so `app.security.csp` is
untouched and `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` keeps its teeth.

## Checking

`GET https://api.github.com/repos/Msgaihede/mtg-grimoire/releases/latest`, carrying the
existing **`scryfall::USER_AGENT`** (`MTGGrimoire/<CARGO_PKG_VERSION> (<repo>)`, already
version-derived — GitHub requires a UA and this one is correct for free), plus
`Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.

The base URL is a **constructor parameter**, exactly as `scryfall::Client::new` takes one, so
`httpmock` can drive the whole path.

- **Throttle: 24 h**, the same shape as the sync's, `force` bypassing it. Unauthenticated
  `api.github.com` allows **60 requests/hour per IP**, shared with everything else on the
  machine — plenty for a daily check, not plenty for a poll.
- **`/releases/latest` excludes drafts and prereleases by construction**, which is exactly the
  failure `releaseDraft: true` is built around: a release under construction is never offered.
- **Version compare** is three `u32`s parsed off `tag_name` with a leading `v` stripped,
  against `env!("CARGO_PKG_VERSION")`. No `semver` crate: release-please emits plain `X.Y.Z`,
  and a prerelease cannot reach this endpoint. A tag that does not parse is "no update".
- **Asset selection is a suffix match, never a literal name.** v0.2.0's assets still read
  `mtg-collection-tracker-0.2.0-…-portable.zip` and `MTG.Collection.Tracker_0.2.0_x64-setup.exe`
  because that release predates the rename; the next will be `mtg-grimoire-…` and
  `MTG.Grimoire_…`. Match on `-windows-x64-portable.zip` and `_x64-setup.exe`,
  case-insensitively. Also: `content_type` is `application/zip` on **all five** assets,
  including the `.exe`, `.deb` and `.msi` — it is useless as a discriminator.

## Install kinds

Windows only; both probes fail naturally elsewhere and land on `Other`, which is the answer
Linux should get anyway.

| Probe | Kind |
|---|---|
| `<exe dir>\uninstall.exe` exists | **Nsis** |
| else, `<exe dir>` is writable (probed, not assumed) | **Portable** |
| else | **Other** |

An MSI install has no `uninstall.exe` and lands in Program Files, so it reads as `Other` and
gets the release-page button. A major upgrade through `msiexec` is deliberately out of scope:
it is unverified, and a wrong guess installs a second copy.

## Downloading

Streams to `<data dir>/updates/<name>.part` against a running SHA-256, reusing the
size-cap-while-streaming discipline from `scryfall.rs` (the bound is on what this process will
hold, not on what a host claims it will send). Progress rides an `update:progress` event
shaped like `sync:progress`.

**The `digest` is the check.** A mismatch deletes the file and reports it — this is the one
place a truncated or swapped object is caught, and it must not be skippable.

## Applying — portable

`zip` extracts `mtg-grimoire.exe` to `<exe dir>\mtg-grimoire.exe.new`. On **Restart to finish**:

1. rename `mtg-grimoire.exe` → `mtg-grimoire.exe.old`
   *(Windows permits renaming a running image; it does not permit replacing one)*
2. rename `.new` → `mtg-grimoire.exe` — **on failure, rename `.old` straight back** and
   report; the window stays up and nothing is lost
3. spawn `mtg-grimoire.exe --await-predecessor`, detached
4. `app.exit(0)` → the existing `RunEvent::Exit` handler checkpoints the WAL as always

The successor waits **before `tauri::Builder::default()` runs**, on the predecessor's process
handle: it is launched as `--await-predecessor <pid>` and calls `OpenProcess(SYNCHRONIZE)` +
`WaitForSingleObject`, capped at fifteen seconds. That needs `windows-sys`, which is already
in the tree via tauri/tao and so costs no build time.

That wait is the whole reason for the flag. Without it the successor starts while the old
process still holds the single-instance lock and gets **exit code 0, no window, no stderr** —
the trap CLAUDE.md already records costing a session, which here looks exactly like a corrupt
update.

> **Corrected 2026-08-09, measured.** This design originally waited by *deleting* the renamed
> image, on the premise that Windows refuses to delete a running executable — making the
> failed delete the liveness signal and the successful one both proof and cleanup. **That
> premise is false.** Rust's `fs::remove_file` uses POSIX-semantics deletion on current
> Windows: the name is unlinked immediately and the file object lives until the last handle
> closes, so the delete succeeds against a running image. The live pass printed *"the previous
> version let go after 0 ms"* while the predecessor had 200 ms still to live, and the
> successor duly vanished. With the process wait it reads **231 ms** and the window comes
> back. `update::tests::deleting_a_file_that_is_still_open_succeeds_on_windows` pins the false
> premise so it cannot be reintroduced. The `.old` delete remains, as cleanup only — never as
> evidence.

## Applying — NSIS

Spawn `<downloaded>-setup.exe /P /R /UPDATE`, then `app.exit(0)` immediately.

Passive, relaunches itself, skips the WebView2 bootstrap and the shortcut refresh. Order is
not arbitrary: the installer's `CheckIfAppIsRunning` macro **kills the running process without
prompting** in passive and silent mode, so exiting first is what lets the WAL checkpoint run.
If it kills us mid-checkpoint anyway, that is already documented as safe — *"a skipped
checkpoint costs disk space, never data."*

Worth naming: a setup.exe **we** downloaded carries no Mark-of-the-Web, so SmartScreen does not
fire on the handoff. The user is still warned on their first manual download. That is a
certificate problem, not an updater problem.

## Storage

**Schema v6** adds `app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, holding
`update_last_check_at` and `update_latest_seen` so the ribbon can show the notice at launch
without waiting for a network round trip.

Deliberately **not** `sync_meta`: CLAUDE.md says that table belongs to the sync, and a
hand-written row in it makes every timing claim afterwards a fiction. New table, same
migration ladder, `SCHEMA_VERSION` → 6.

## Dependencies

Two crates: **`sha2`** (verify the digest) and **`zip`**, `default-features = false,
features = ["deflate"]` — `Compress-Archive` writes plain deflate. The alternative to `zip` is
publishing a bare `.exe` asset beside the archive, trading a small pure-Rust dependency for a
second artifact that can silently go stale.

Plus **`windows-sys`** under `[target.'cfg(windows)'.dependencies]`, for `OpenProcess` and
`WaitForSingleObject` — see the correction above. It is already in the tree at the same
version, so it adds no build.

**`release.yml` does not change.** The digest is already there, the assets are already there,
`/releases/latest` already excludes drafts. No signing keypair, no `latest.json` — the CI
spec's *"adding it later is additive and nothing here forecloses it"* turns out to be
literally true.

## Testing

- **Rust** over a fixture of the real measured API payload: asset selection under the
  *renamed* product, version compare, digest mismatch, install-kind detection against
  temp-dir layouts, and the `.old`/`.new` swap including its rollback. `httpmock` for the
  request itself.
- **Vitest** for the ribbon affordance, the panel's states and the hook's state machine.
- **Live, over CDP**, as CLAUDE.md requires for any UI task.
- **By hand, and nothing else can reach it:** build a release exe, stand up a local release
  fixture, and watch the portable swap and relaunch actually happen. The single-instance race
  is invisible to every other kind of check.

## Non-goals

- No minisign keypair, no `latest.json`, no `tauri-plugin-updater`.
- No background auto-install: the user chooses when the window closes.
- No rollback to a previous version, no delta updates.
- No MSI in-app apply (see **Install kinds**).
- No code signing. Still a purchase, not a workflow change.
