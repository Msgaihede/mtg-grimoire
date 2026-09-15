# Scanner modes, filters, a review tray, and the bundle shipped — design

**Date:** 2026-09-15
**Status:** approved in conversation; spec under review
**Scope:** the four items [the in-app spec](2026-09-08-scanner-in-app-design.md) §13 deferred,
less the wasm one — the reference bundle and the OCR models ship inside the app, the scanner
gains a **Fast** and an **Exact** mode, candidates can be narrowed by **set** and **release
date**, and a scanned card lands in a **review tray** that commits to the collection. Plus a
synthetic evaluation, because the sample photographs are gone.

Companions: [the scanner design](2026-09-01-card-scanner-design.md), the in-app spec above, the
brief at [`docs/scanner/card-scanner.md`](../../scanner/card-scanner.md), and the record at
[`docs/reference/card-scanner.md`](../../reference/card-scanner.md), whose section numbers this
document cites as "§n".

---

## 1. What this is

Today the Scanner view is the debug page in the app's chrome: it votes on a card, writes nothing,
and asks the reader to drop a 5.4 MB bundle and two model files into `data/scanner/` by hand. A
release build therefore cannot scan anything at all.

After this pass a reader opens Scanner, picks **Fast** to sweep a pile or **Exact** to pin every
printing, optionally restricts it to the sets they are scanning, and watches cards collect in a
tray beside the camera. They correct a printing, bump a quantity, and press **Add N to
collection**. The developer panels are still one switch away.

## 2. The facts this rests on

Checked 2026-09-15 unless stated.

| Fact | Value |
| --- | --- |
| The sample corpus | **Gone.** `docs/scanner/scans/` was untracked in the `card-scanner-first-pass` worktree, which is now an empty directory; a search of `D:\Code` and the user folders finds no copy. The bundle, its 1.28 GB fetch cache and the models went with it |
| The bundle | `card-hashes-v5.bin`, 5,442,032 bytes, 113,375 printings, card section only (§2). `FORMAT_VERSION` 5 |
| What `build-hashes` reads | `SELECT id, illustration_id, image_uris FROM cards WHERE image_uris IS NOT NULL` against a `corpus.db` — CI has no corpus |
| A full build from empty | 168,582 images at ~93/s, roughly half an hour, ~1.28 GB of thumbs cached (§2) |
| The models | `text-detection.rten` 2.5 MB + `text-recognition.rten` 9.7 MB from `https://ocrs-models.s3-accelerate.amazonaws.com`; trained on HierText, **CC-BY-SA 4.0** (ocrs-models README) |
| The portable release | one exe in a zip (`release.yml`), frontend embedded, so an asset beside it is a second file to lose. Android is one APK, built locally |
| The release job | a matrix of `tauri-apps/tauri-action@v1` legs, Linux among them |
| `src-tauri/build.rs` | exists; returns early for `wasm32` |
| Filters in the crate | `index::Mask` already filters **during** the search (§3 "Match"); `session.rs` passes `Mask::all()` at its one call site |
| Labels | `Reference::load_labels` reads `name, set_code, collector_number, lang, released_at` and the oracle id from `corpus.db` |
| Collection batch write | `collection_import_commit(items, mode, folderId)` — one transaction for many rows into one folder |
| Per-reader prefs off the synced tables | `app_meta`, one key–value table on every target |
| Sets for a picker | `ipc.listSets()` → `SetSummary[]` |
| Printing picker | `src/features/card/AllPrintingsDialog.tsx` with `PrintingsFilterBar` |

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **A CI workflow builds the bundle and publishes it with both models to a versioned release tag; the release build downloads and embeds them** | Git stays free of a 5.4 MB binary that changes every set; the portable exe stays one file |
| 2 | **A file in `data/scanner/` overrides the embedded copy** | Trying a new bundle needs no rebuild; a PR build without the assets keeps today's placement sentence |
| 3 | **A release fails if the assets are missing** | A release that silently cannot scan is a regression nobody would see until a reader tried |
| 4 | **Testing is synthetic for now** — Scryfall renders, degraded deterministically | The photographs cannot be recovered; the figures are a regression fence, not an accuracy claim |
| 5 | **Exact = the live lock, then an explicit tier pipeline over a three-frame burst** | Keeps the multi-frame consistency the tracker's failures taught (§5), and yields a real "what remains" set to show |
| 6 | **Fast = the vote rule, hash only, with a title-read rescue after a leaderless stretch** | Common cards stay at hash speed; a foil still resolves (§4 "The name tier") |
| 7 | **Filters: sets and a release-date range. Language is not in this pass at all** — no filter, no tray default | Asked for on 2026-09-15; `default_cards` holds one printing per card, English wherever English exists, so a language filter over the bundle would bite only on printings that exist solely in another language |
| 8 | **A decided card lands in a review tray, persisted in `app_meta`, committed in one batch to a chosen folder** | A wrong match is fixed before it is a collection edit, and a crash mid-session loses nothing |
| 9 | **Both modes add automatically; a card must leave the frame before it can be added again** | The tracker's freeze rule (§5 "What ends a freeze") already defines "left"; a second copy is a quantity bump or a re-presentation |
| 10 | **Today's panels move behind a Developer switch, joined by a Tiers panel** | Nothing debuggable today is lost; a reader who is only scanning pays for none of it |

## 4. Shipping the bundle

### 4.1 The workflow — `.github/workflows/scanner-bundle.yml`

Triggers: `workflow_dispatch` and a **weekly** schedule. Weekly rather than monthly because
`actions/cache` evicts an entry unused for seven days, and the cache is what makes a run cost a
new set's few hundred fetches instead of half an hour and 1.28 GB.

1. Fetch Scryfall's `default_cards` bulk file (resolve `download_uri` from
   `https://api.scryfall.com/bulk-data/default-cards`, with a `User-Agent` — §2 records the 400
   `cards.scryfall.io` answers without one).
2. Restore the fetch cache, keyed `scanner-cache-v<FORMAT_VERSION>` with a restore prefix, so a
   descriptor change re-hashes cached images rather than refetching them (§2 "The incremental
   cache").
3. `cargo run --release --bin build-hashes --features builder -- --bulk default-cards.json --out
   card-hashes-v<FORMAT_VERSION>.bin`. **`--bulk` is new**: it streams the JSON array (the file is
   hundreds of megabytes; it is never held whole) and yields the same `(id, illustration_id,
   image_uris)` rows the `--corpus` query does. `--corpus` stays.
4. Fetch both models with `crates/card-scanner/scripts/fetch-ocr-models.mjs`.
5. Run the synthetic evaluation (§5) and write its table to the job summary.
6. Publish to the release **`scanner-bundle-v<FORMAT_VERSION>`** — created if absent,
   **prerelease and not latest**, assets replaced with `--clobber` — but only when the bundle's
   bytes differ from the asset already there.

**The format version is in the tag, not only in the file.** An app built at version 5 downloads
from `scanner-bundle-v5` and cannot pick up a version 6 bundle whose descriptors it would read as
noise — the silent-mismatch §2 exists to prevent, moved from load time to build time. The
header check at load stays as the second fence.

**Prerelease and not latest** so nothing that asks GitHub for the latest release — the in-app
updater among them ([in-app-updates.md](../../reference/in-app-updates.md)) — is ever handed a
bundle. The plan verifies which endpoint the updater reads before relying on this.

### 4.2 Embedding

- **`src-tauri/scanner-assets/`**, gitignored, holds `card-hashes.bin`, `text-detection.rten` and
  `text-recognition.rten` when present.
- **`npm run scanner:assets`** (a node script) downloads the three from the tag matching the
  crate's `FORMAT_VERSION`, so a developer, the Android build and the release job all fetch the
  same way. The crate exposes the version where the script can read it without compiling.
- **`build.rs`** declares `cargo:rustc-check-cfg=cfg(scanner_assets)`, emits
  `cargo:rerun-if-changed` for the directory and each file, and sets `cfg(scanner_assets)` when
  all three are present — on non-wasm targets only, after the existing wasm early return. The
  three load together or the cfg is off: a bundle embedded without models, or the reverse, is a
  half-shipped scanner.
- **`scanner.rs`** `include_bytes!`s them under `#[cfg(scanner_assets)]`.
- **`release.yml`** runs `npm run scanner:assets` on every matrix leg before `tauri-action`, and
  fails the leg if it fails (decision 3).

### 4.3 Load order, and the status the page draws

Per asset, first hit wins: **a file in `data/scanner/`**, then **the embedded copy**, then
**absent**. The two models stay a pair.

`Asset` gains `source: "file" | "embedded" | "absent"`. The three-state sentences of §9 stay for
`file` and `absent`; `embedded` draws nothing on the reader's view and names itself in the
Developer panels. `Bundle::from_bytes` already takes a slice, so the embedded path is the same
parse over `&'static [u8]`.

### 4.4 Licence

The models are trained on HierText (CC-BY-SA 4.0). The app's licence/about text gains an
attribution line for ocrs and its models. `ocrs` and `rten` themselves are already dependencies
and are covered however the app covers the rest of its crates.

## 5. The synthetic evaluation

A new binary, **`eval`**, behind the `builder` feature (it needs `ureq` and the fetch cache).

- **The set of cards** is a committed list, `crates/card-scanner/eval/printings.txt`, of ~150
  Scryfall ids stratified the way §2's size sample was — across frame eras — and deliberately
  including the cases this crate has a recorded failure on: basic lands from one set (§3 "Hash"),
  borderless and full-art printings (§3 "Detect"), split and double-faced cards, and several
  reprints of one card (§5 "Group by oracle id").
- **The source image is Scryfall's `large` render**, never the `small` thumb the bundle is hashed
  from, so a match is not a byte-identical lookup.
- **Each card becomes a burst of 12 frames**, generated from a fixed seed: a perspective warp,
  a rotation anywhere in 360°, a scale putting the card at 25–70% of the frame, a procedural
  background (flat, noise, wood-like stripes), a white-balance and exposure shift, one specular
  glare blob, Gaussian blur, and JPEG at q60–90. Frame-to-frame jitter is small, as a hand is.
- **Each burst is fed through `Session`** in each mode, exactly as the app feeds it.
- **The table:** per mode, card accuracy, printing accuracy, ambiguous rate (Exact), not-found
  rate, frames to a decision, and release ms per frame — overall and per stratum.
- **Filters are exercised** by a second Exact pass with each card's own set as the only allowed
  set, which is the brief's stated use and should move printing accuracy up.

**What its numbers are.** The pixels are Scryfall's own renders, the same art the bundle was
hashed from at a different size, so appearance accuracy will read higher than any camera. The
table is a fence against a regression and a way to set the two thresholds below — never a
claim about a real scan. That sentence goes in the reference doc beside the table.

**The unit tests do not need it.** Tier and filter logic are tested with tiny in-test bundles
built from generated images, the way `reference.rs`'s tests already build them, so `cargo test`
needs no network and no assets.

## 6. The crate

### 6.1 Filters

```rust
pub struct ScanFilters {
    pub sets: Vec<String>,            // set codes, compared case-insensitively; empty = any
    pub released_from: Option<String>, // "YYYY-MM-DD", inclusive
    pub released_to: Option<String>,   // inclusive
}
```

`Session::set_filters(filters)` builds a `Mask` from the loaded labels — one pass over the
printings, a lexicographic date compare — and holds it until the next call. An empty
`ScanFilters` is `Mask::all()`, which keeps the unfiltered search on its existing fast path.

**The mask constrains every tier, not only the hash search.** `lookup_by_name` resolves only to a
card with at least one permitted printing, and `lookup_collector` / `lookup_pair` only to a
permitted printing. Otherwise a title read could answer with a card from an excluded set and a
collector read with an excluded printing — "the filters hide some answers" rather than "only
matching cards are valid", which §3 already rejected for the hash tier.

**Without a corpus there are no labels, so there is no mask to build.** `set_filters` returns an
error sentence and the page disables the Filters control with it.

Changing the filters resets the tracker: evidence gathered against a different candidate set is
evidence about a different question.

### 6.2 The mode

```rust
pub enum ScanMode { Fast, Exact }   // FrameOptions::mode, default Fast
```

It rides `FrameOptions` like the rule and the sliders do, so the debug page can A/B it with a
query parameter. Switching it resets the tracker and any resolution.

### 6.3 Fast

The current loop, with one change to the reader cadence: **the readers are eligible only after
`FAST_RESCUE_AFTER` (8) consecutive locked frames with no committed card**. Before that, a Fast
frame is hash only. After it, `OCR_EVERY` applies as today. Only the title reader runs in Fast;
the collector read is what Exact is for.

The printing is the tracker's printing accumulator, as today, over a masked search — which is
where a set filter does most of its work in this mode.

`decide_at`, the framing count and the gates keep their current values. The eval reports frames
to a decision, and a change to any of them is its own measured commit.

### 6.4 Exact

The same detect, lock and tracker loop runs every frame — the tracker still decides *which card*
is in front of the lens and still owns "has it left". What Exact adds is a **resolve**.

**When.** On the first frame where the lock has held for `EXACT_STEADY_FRAMES` (3) and there is no
resolution for the card in frame, the session runs a resolve over the rectified views of the last
three locked frames, which it keeps in a ring buffer while in Exact.

**The tiers.** Each takes the survivors of the one before; each records what it did.

| Tier | Does | Survivors |
| --- | --- | --- |
| 0 filters | the mask | every permitted printing |
| 1 whole card | a masked search of every view in the burst, top 32, inside `max_normalized` | those printings, grouped by oracle id |
| 2 title | read the title on the burst's best view by cardness, falling back once to the second-best view on no read | a resolved name → **every permitted printing of that card**, whether or not tier 1 found it (the foil rescue, §4). No read → tier 1's |
| 3 collector | read the collector line the same way | a resolved printing whose card is among the survivors' cards → that printing alone. A resolved printing of **another** card is recorded as a conflict and ignored (§4: a misread digit is a different real card). No read → unchanged |
| 4 re-rank | the best distance each survivor achieves across the burst | the best printing alone if it leads the second by `EXACT_MARGIN_BITS` (initially 6, set by the eval); otherwise every printing within that margin of the best |
| 5 classifier | the existing trait slot; no implementation | unchanged |

**The outcome** is one of:

- `Resolved { printing }` — one survivor.
- `Ambiguous { printings }` — 2 to `EXACT_MAX_CHOICES` (12) survivors, best first. More than 12
  is reported as the top 12, because a picker longer than that is not a choice anybody makes.
- `NotFound` — no survivor after tier 1 and no name read.

**What a resolve costs.** Up to two title reads and two collector reads in the worst case —
~2 s release against §4's figures — spent once per card, synchronously inside that frame's
command. The page's one-request-in-flight loop tolerates a long frame by dropping the ones behind
it, and the status line says *Reading…* while it runs. The figure is owed (§11).

**After a resolve** the tracker is committed and frozen on the resolved card's oracle id through a
new `Tracker::commit_to(key, member)`, so exactly the rules of §5 "What ends a freeze" decide when
the card has left and the next resolve may run. There is one definition of "left" in the crate,
not a second one for Exact. An `Ambiguous` outcome commits on its **best** printing's oracle id,
even when its choices span several cards — the tray row carries the choice, and the freeze only
has to know that *a* card is being held. `NotFound` commits nothing; the next steady stretch
tries again.

### 6.5 The verdict

Three additions, snake case like the rest:

| Key | Type | Meaning |
| --- | --- | --- |
| `mode` | `"fast" \| "exact"` | which mode judged this frame |
| `decision_seq` | `u64` | increments once per new decision (Fast) or resolve outcome other than `NotFound` (Exact); the page adds a tray row when it changes and never otherwise |
| `resolution` | object or null | on the frame a resolve ran: `outcome`, its printings with labels, and `tiers: [{ tier, survivors, detail }]` |

`decision_seq` is what makes "one add per card" a property of the session rather than of the
page's timing: a dropped frame, a re-render or a second listener cannot add twice, because the
number did not change.

`live.html` gains a mode segment and a filters field that ride the query string, and the key-scrape
fence (§9) keeps holding: every new key it reads is in the verdict.

## 7. The app's commands

| Command | In | Out | New? |
| --- | --- | --- | --- |
| `scanner_status` | — | `ScannerStatus`, each `Asset` now with `source` | changed |
| `scanner_frame` | frame, `FrameOptions` (now with `mode`) | `Verdict` | changed |
| `scanner_reset` | — | `()` | — |
| `scanner_capture` | frame, `Sidecar` | `Captured` | — |
| `scanner_set_filters` | `ScanFilters` | `()` or a sentence | **new** |
| `scanner_prefs_get` / `scanner_prefs_set` | — / `ScannerPrefs` JSON | | **new** |
| `scanner_tray_get` / `scanner_tray_set` | — / `TrayRow[]` JSON | | **new** |

The four new ones are `#[cfg(not(target_family = "wasm"))]` like their siblings. Prefs and tray
are two `app_meta` keys, `scanner_prefs` and `scanner_tray`, each one JSON value written whole.
No schema rung, and neither is a synced table, so nothing here reaches the relay.

`ScannerPrefs` carries the mode, the filters, the row defaults (finish, condition and folder, as
far as the collection's grain carries each — the plan names the exact fields from
`CollectionImportItem`), and the Developer switch. A tray row records no language; the collection
row takes whatever the import commit defaults it to. On mount the page reads prefs and pushes the
filters to the session before the first frame.

The tray is committed through **`collection_import_commit`**, once for all rows, with the chosen
folder — the existing one-transaction batch, so the activity log and every other write-site rule
the import already honours hold without a second copy. Rows it wrote leave the tray; a row it
refused stays with its sentence.

## 8. The view

`src/features/scanner/`. The web target's one sentence is unchanged.

**The bar**, above the camera: a **Fast | Exact** segment; **Filters** (a popover: a set
multi-select fed by `listSets`, two date fields, a clear); **Defaults** (a popover: finish,
condition, folder); and a **Developer** switch at its end.

**The camera** with its overlay, and one status line under it that names what the scanner is
doing in words: *Point the camera at a card* · *Hold steady* · *Reading the title…* · *Added
Forest — HOB 193* · *Pick a printing below* · *No match — try Exact, or better light*.

**The tray**, the column beside the camera on a wide window and below it on a narrow one (the
existing `useNarrowWindow` arm). Newest first. Each row: the card image, name, set and number,
finish, a quantity stepper, **Change printing** (the existing all-printings dialog), and remove. An
`Ambiguous` row reads *Pick a printing* and lays its candidates out as small images to click; the
camera keeps running while it waits, so an unresolved row never stops the next card. A re-added
card that is already the newest row with the same printing bumps its quantity instead of adding
a row, and the flash says ×2. At the foot, a folder picker and **Add N to collection**, disabled
while any row is unpicked or the tray is empty.

**The Developer switch** shows today's panels (§9 "The view") and a new **Tiers** panel: the last
resolve's tiers as a list — tier, survivor count, and the detail (the read name, the collector
pairing, a conflict, the margin). Off, the panel column is gone and the tray takes its place.

The existing `MatchPanel` stays a developer panel. The reader's view never shows votes, a lead or a
distance.

## 9. Storybook and tests

**Rust.** Filters: a mask built from labels permits exactly the chosen sets and dates, an empty
filter is unrestricted, a name read and a collector read cannot resolve outside the mask, no
corpus is a sentence. Exact: each tier's narrowing on a hand-built bundle — a name read reaches a
printing tier 1 missed, a collector read of another card is a recorded conflict, the margin
splits `Resolved` from `Ambiguous`, more than twelve truncates. `decision_seq` moves once per
decision and not on frozen frames. Fast: no reader runs before the eighth leaderless locked frame.
Loading: `file` beats `embedded` beats `absent`, per asset, models as a pair. `build.rs` is
proven by building with and without the directory, not by a unit test.

**TS.** The tray reducer (add, bump on re-add, pick, change printing, remove, commit keeps
refused rows), the verdict-to-row mapping keyed on `decision_seq`, prefs round-trip, and the
status-line sentences. `ipc.test.ts`'s `snakeMirrors` gains the new structs.

**Storybook.** `scannerHandlers` answers the new commands from an in-memory tray and prefs; stories
for the reader view in each state (empty tray, rows, an ambiguous row, a refused commit, filters
open, assets embedded) and the Tiers panel.

**Live.** Driven in the app over CDP against a card on the desk, both modes, and the tray
committed into a real folder of the dev database — then those rows deleted (root `CLAUDE.md`,
"seed user tables only").

## 10. Documentation

- `docs/reference/card-scanner.md` gains **§10 Modes, filters, the tray and the shipped bundle**,
  and §8's first two open bugs are rewritten: the corpus is not merely unversioned, it is lost.
- The in-app spec's §13 list is not edited; this spec is its answer.
- `src-tauri/CLAUDE.md`: the `scanner_assets` cfg and the load order. `.github/CLAUDE.md`: the new
  workflow and the release step. `src/CLAUDE.md` only if a rule binds beyond the scanner feature.
- The brief (`docs/scanner/card-scanner.md`) is left as the brief; this spec records what was
  built from it.

## 11. Measurements to take during implementation

1. The exe's size with the assets embedded, against without.
2. The first `scanner_status` with the embedded bundle, release and debug, against §9's 798 ms.
3. An Exact resolve's wall time, release, with and without the readers finding text.
4. The eval's first table, both modes, and the two thresholds it sets.
5. The bundle workflow's first cold run and a warm one.
6. Whether the updater's release lookup can ever return the `scanner-bundle-v5` prerelease.

## 12. Deliberately not in this pass

- A real-photograph corpus. The add-to-dataset button still works and still writes
  `data/scanner/scans/`; committing a corpus is the pass after one exists.
- Hashing new printings on the device. An embedded bundle cannot match a card released after
  the build; the weekly workflow narrows that to the next app release.
- The art tier and the AI classifier.
- Language, in any form — neither a filter nor a tray default.
- Writing straight to the collection without the tray, and wishlist or deck destinations.
- Compiling the crate to wasm.
