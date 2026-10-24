# The card scanner: the crate, the session, and the app's Scanner

Identify a physical Magic card from a camera frame, locally. This is the record of the scanner as
it stands: the `crates/card-scanner` crate that turns `crates/card-neural`'s reads into decisions,
the hosts that hand it frames, the app's Scanner view and its review tray, and the replay of
readers' scans that measures it. **The Neural scanner is the only one.** The Fast and Exact modes,
and the algorithmic pipeline under them — the edge detector, the quad lock, the perceptual-hash
bundle `card-hashes.bin`, the OCR title and collector readers and their two `.rten` models, Exact's
resolve tiers, the tracker, the appearance watch, reframing, the synthetic evaluation, the frame
bench and the debug server — were removed on 2026-10-24, with the weekly `scanner-bundle.yml`
workflow and the in-app download of the bundle and models. The designs that shaped what is left are
[the 2026-09-08 in-app spec](../superpowers/specs/2026-09-08-scanner-in-app-design.md) (§9), [the
2026-10-20 Neural plan](../superpowers/plans/2026-10-20-neural-scan-mode.md) and [the 2026-10-21
printing-evidence design](../superpowers/specs/2026-10-21-neural-printing-evidence-design.md) (§10);
this document is what the code does.

**Same contract as every other file here: a figure carries its date and its build.**

**Every accuracy figure rests on the 124 readers' scans received 2026-10-12 to 2026-10-15**
(§10, *The replay*), and the Neural thresholds were tuned on those same scans. Newer scans are the
honest test.

**Scanning does not require collection eligibility (#742).** The gallery and the corpus labels
cover tokens, emblems, art series and memorabilia as well as cards; set and date filters use the
same unrestricted vocabulary. A card without an oracle id uses its printing id as its identity for
a second opinion (§5), while the decision and the stored tray keep the oracle id absent.
Recognition and the later Add are separate: storing a scan writes no collection entry, and a
refused Add leaves the stored tray intact.

## 1. What it is and where it lives

`crates/card-scanner/`. **It knows nothing about cameras**: a frame is a JPEG, and where it came
from — a webcam, a phone, a Tauri command, a reader's scan in the inbox — is the caller's business.
That is what lets one implementation serve every host and the replay.

| Module | What |
| --- | --- |
| `session` | `Session`: one frame in, one `Verdict` out — the decode and its bounds, the filters' mask, the decision count and the panic guard (§3) |
| `session::neural_mode` (`src/neural_mode.rs`, a child of `session` by `#[path]`) | The recogniser's frame: the read, the agreement, the decision (§4, §5) |
| `neural` | `card_neural`, re-exported for a host handing the session its files |
| `reference` | `Reference`: the corpus labels — names, oracle ids, finishes, promos, tokens — and the masks a filter builds (§6) |
| `labels` | The labels as bytes, for a host with no database (§2) |
| `filters` | `ScanFilters` (§6) |
| `ids` | A 16-byte id, `format_uuid` / `parse_uuid`, `Mask` |
| `host` | The one file that knows the machine: `Stopwatch`, `set_clock`, `guard` (§11) |
| `replay` | A scan inbox label read and scored, with no session and no file (§10) |

**Two features, and the app takes one.** `corpus` (`rusqlite`) is the join back to the app's
`corpus.db` — `Reference::load_labels` and `labels::read_page`; `grimoire-core` enables it. `cli`
(`clap`, `corpus`, `card-neural/cli`) builds the one binary, `replay` (§10). The browser's module
(`crates/grimoire-scan`) takes neither. `card-neural` is a plain dependency; its own `bundled`
feature, which compiles the model files in (`card_neural::bundled()`), is the native hosts' to turn
on.

**Not a member of the root workspace.** The root `Cargo.toml` excludes it by name, because the
crate is not `cargo fmt`-clean and carries clippy warnings (§8), which membership would put under
`--workspace` lints. **Its manifest carries an empty `[workspace]` table, which is not optional**:
excluded from the root, cargo would otherwise keep walking up the parent directories, and an agent
worktree sits under the main checkout, whose root manifest knows nothing of a crate inside a
worktree and refuses it (`current package believes it's in a workspace when it's not`; reproduced
2026-10-02). It builds into `crates/card-scanner/target/` (ignored as `crates/*/target/`): the
folder's own `.cargo/config.toml` sets that for a run started inside it, and a run from the root
with `--manifest-path` needs `--target-dir crates/card-scanner/target`, because cargo reads config
from the working directory — without the flag the build lands in the root's `target/` and compiles
once more.

**Its `[profile.dev.package.*]` overrides (`image`, `card-neural`, `rten` at `opt-level = 3`)
apply only when this crate is the build root.** A JPEG decode and the recogniser are unusably slow
unoptimised; cargo reads `[profile.*]` from the build root alone, so the app's dev builds get the
root `Cargo.toml`'s own list, measured there.

| Path | What | In git? |
| --- | --- | --- |
| `crates/card-neural/models/` | The recogniser's eight files (§10) | Yes |
| `.scanner-corpus/` | Readers' scans mirrored from the corpus bucket, and the replay's output (§10). In the main checkout | Ignored, and never committed: the frames are readers' photographs |
| `data/scanner/scans/` | `scanner_capture`'s frames and sidecars (§9) | Ignored, as all of `data/` |
| `docs/scanner/card-scanner.md` | The original brief | Yes |

## 2. The labels, as bytes

The recogniser answers with a printing id. What an id *is* — a name, a set, a number, a language,
a release date, an oracle, its finishes, whether it is a promo or a token — is eleven columns of
`corpus.db`'s `cards`, which `Reference::load_labels` reads behind `corpus` (`labels::COLUMNS`).
**A browser's scanner has no `corpus` feature**: it is a module of this crate alone in a Worker of
its own (`crates/grimoire-scan`), and the corpus is the engine's, in another Worker. So the engine
reads the same columns, writes them down, and the page hands the bytes across. `src/labels.rs` is
both ends:

| | Needs `corpus` | What |
| --- | --- | --- |
| `Row`, `Row::attach` | no | One printing as the corpus has it, and the four calls that attach it — `set_finishes`, `set_promo`, `set_token`, then `add_label`. `load_labels` goes through the same four |
| `is_token` | no | Whether a `layout` and `type_line` make a token or an emblem — the engine's `deck_tokens::is_token_printing`, spelled again and held to it by that function's test |
| `Encoder` | no | `push(&Row)` a row at a time, `finish()` the file |
| `decode`, `attach` | no | Read a file through and answer it only if all of it is sound; attach every row, or none |
| `COLUMNS`, `Row::from_sql`, `read_page` | yes | The columns, one row read from them, and `limit` rows after a `rowid` into an `Encoder` |

**The layout, version 4** (`MAGIC` `MTGL`, `VERSION` 4; a varint is LEB128, ten bytes at most):

```text
"MTGL" · version (1 byte) · rows (varint)
six string tables — name, set, collector number, language, release date, finish —
    each: entries (varint), then per entry a length (varint) and that many bytes of UTF-8
one id table — oracle: entries (varint), then 16 bytes per entry
rows ×  id (16 bytes)
        oracle                     varint: 0 for none, else 1 + its place in the table
        name, set, number,         varint each: a place in its table
          language, released
        finishes                   varint n, then n places in the finish table
        flags                      1 byte: 1 (`PROMO`) for a printing `cards.promo` marks,
                                     2 (`TOKEN`) for a token or an emblem; no other bit
```

Version 1 had no promo byte (added for the promo filter, issue #981); version 3 made it the flags,
for the tokens a session leaves out (issue #1323); version 4 (2026-10-24) dropped the illustration
id table and column, which only the hash bundle's art search read. Both ends of a hand-over are one
build, so an older file is never met, and is refused like any other.

**Tables, because a label is mostly words it shares**: the dev corpus's 118 475 printings (counted
2026-10-07) have 38 260 names, 1 052 sets, 16 833 collector numbers, 19 languages, 1 288 release
dates and 38 705 oracle ids. Each table is in first-seen order, so the encoder is one pass and holds
no row. The file was 5 998 193 B for those rows in version 3, 51 236 illustration ids included;
version 4 has not been measured. **Rows are in the order they were pushed, and that order is
behaviour**: `read_page` reads `ORDER BY rowid`, the order `load_labels` attaches in, and a
printing met twice keeps its later label either way. A release date that was `NULL` is the empty
string.

**The decoder trusts nothing**, because a module that panics is a module that has ended (§11).
Every count is held against the bytes that are left before anything is allocated for it, every
place against its table, every string against UTF-8, and `attach` reads the whole file before it
attaches the first row. A refusal is a `LabelsError` — `BadMagic`, `BadVersion`, `Truncated` or
`Damaged`, each a sentence with the byte it happened at — and leaves the reference as it was. Its
tests cut a file short at every length, set every byte to each of six values, and hand it a row
count and a table count of four billion.

`labels::tests::the_whole_corpus_encodes_to_the_reference_load_labels_builds` holds the promise at
its real size — the reference attached from the file is the one `load_labels` builds from the same
corpus (`Reference::snapshot`, test-only) — and prints one digest of it. It is `#[ignore]`d and
wants a corpus:

```
SCANNER_LABELS_CORPUS=<corpus.db> [SCANNER_LABELS_OUT=<file>] cargo test --release \
  --features cli --lib labels::tests::the_whole_corpus -- --ignored --nocapture
```

Measured on the dev corpus, 2026-10-07 (version 1, a Ryzen 9 5900X shared with other builds):
`read_page` with the encode 1.4–2.0 s natively (release); `decode` alone 16–17 ms; decode and
attach 0.6–0.8 s natively and 0.6–0.9 s in the Worker.

## 3. One frame, end to end

```rust
Session::new(reference: Option<Reference>, top: usize)   // top: candidates a frame, 1 to 25
session.load_neural(card_neural::Files)                   // the recogniser's four files
session.load_neural_evidence(card_neural::EvidenceFiles)  // the printing evidence's four (§10)
session.frame(jpeg: &[u8]) -> Verdict
```

**A frame takes no options**: the thresholds travel with the models (`neural.json`) and the
agreement's rules are `card-neural`'s own. What happens to it:

1. **Decode, as a JPEG and within bounds** (`session::decode_frame`, issue #1137). JPEG only — PNG
   and WebP, which `image::load_from_memory` would have guessed from the bytes, are refused — at
   most `MAX_FRAME_SIDE` (8192 px) a side and `MAX_FRAME_PIXELS` (24 MP) in all, judged from the
   header before a pixel is allocated. Enforced here so no host needs checks of its own: WASM
   linear memory never shrinks, and a 13k×13k grayscale frame tripled to RGB would have stayed in
   the Worker for good.
2. **Read** (`card_neural::Recognizer::read`): find every card in the frame, fingerprint each, and
   rank it against the looks the filters admit (§6). The frame votes for **the card under its
   middle**, recognised or not.
3. **Count** (`card_neural::Agreement::observe`, §4), and build the verdict, the decision on a new
   one (§5).

**Never panics where a panic can be caught**: `Session::frame` runs inside `host::guard`, and a
frame the image crates or the network runtime assert on answers `PANIC_ERROR` and the session
carries on. On a host where a panic aborts the guard guards nothing (§11).

**The verdict's keys are the page's**, snake case, mirrored by hand in
`packages/ui/lib/ipc/scanner.ts` and held to the Rust text by `packages/ui/lib/ipc.test.ts`
(§9, *The IPC seam*):

| Key | What |
| --- | --- |
| `ok`, `error` | `error` is omitted when there is none. `"no card"` is the ordinary empty frame |
| `frame` | `{ w, h }` as decoded |
| `decode_ms`, `read_ms` | The decode, and the recogniser's read — detector, embedder and search at once |
| `matcher` | Whether the recogniser is loaded at all: "no models" and "loaded, no card in this frame" are different states |
| `quad` | The card the frame votes for, four corners in the frame's pixels, or `null` |
| `candidates_examined` | The cards the detector found and the embedder read |
| `match` | `{ rotated, candidates, margin }`: that card's best looks, best first, each as its pictured printing — `Candidate { id, distance, normalized, label, printings }` |
| `tracked` | The agreement's state (§4) |
| `decision_seq`, `decision` | §5 |

**The distances are cosines on the old scale**: `normalized` is (1 − cosine) / 2, 0 for the
picture itself and 1 for its opposite; `distance` is that × 256, so a panel or the scan inbox that
reads 0–256 bits still holds; `margin` is the lead over the best look of another card × 128.
`printings` is how many printings photograph alike under the look — the reason a look cannot always
name a printing.

**What counts as a failure** (`Verdict::failure`) — the scanner could not judge the frame, as
against "no card": `PANIC_ERROR`, `NEURAL_UNAVAILABLE_ERROR` (*the Neural scanner's models are not
loaded* — a failure, so a replay or a page cannot take a scanner that never ran for one that saw
nothing), and anything starting `DECODE_ERROR_PREFIX` (`decode: `) or `NEURAL_ERROR_PREFIX`
(`neural: ` — a model that would not run, a frame too small to read). A failed frame still carries
`decision_seq`; the agreement never hears of it.

**`load_neural` drops the first recogniser before building the second**, so a browser's module —
whose memory is never given back — does not hold two at once (37.8 MiB for one, 66.1 MiB while the
old one lived on). A refused load leaves the scanner unavailable; a refused evidence load leaves the
recogniser deciding without it.

## 4. The agreement

`card_neural::Agreement`, its `Rules` defaults: **two accepted frames of one card decide it**
(`required`), **or three when some are only supported** (`support_required`), **or one instant
frame** whose read is sure on its own. Two frames agree only within `max_gap_ms` (850 ms) of each
other, and a vote older than `max_age_ms` (1.8 s) is dropped. The ages are read off the session's
clock (`host::Stopwatch`, started at `load_neural`), never off `Instant`; a host with no clock
reads every frame at zero, so no vote ages (§11), and the replay installs the label's own frame
times.

`tracked`, on every read frame: `committed` while a decision stands; `confidence`, the votes held
over what deciding takes, 1 once decided; `decide_at` (2); `streak`, the votes held; `frames`
since the card was last forgotten; `misses`, frames running with no card; and `standings` — the
decided look first, then the look the votes are counting when it is another card, each
`{ id, evidence, share, seen, label, best_distance }`.

**Five frames running with no card in front of the lens forget the decision** (`forget_after`,
`card_neural::Read::present`): a stretch break. The same card shown again then adds again, and the
previous decision a later one could replace is cleared with it (§5).

**A second printing laid on the decided card adds** (#1359). The agreement counts votes by card,
so another look of the decided card stacked on it was the same card, and never decided. While a
card is decided its votes are counted by **look**, and **three accepted frames running**
(`another_look`) whose look the picture tells apart from the deciding frame's (neither among the
other's twins, `TWIN_GAP`) decide that look (`Decision::another_look`) — one frame more than a card
takes, because a held card's best look can waver and a change made in error adds a row. The session
takes it as a second copy, `replaces_previous` false — **unless its printing is the one the last
decision named**, which is the card's own look wavering, and replaces its row. The frames of the
other look are kept for the printing evidence, so it chooses the second printing on them. Not
measured on readers' scans.

**What it cannot see**: a second copy of the same printing laid on the first — nothing about it
looks different. Lift the first away for five frames, or use the tray's quantity stepper.

## 5. The decision

**`decision_seq` is what makes one add per card a property of the session rather than of the
page's timing.** It moves once per new decision — when `card_neural::Agreement::decisions` does —
and on no other frame, so a dropped frame, a re-render or a second listener cannot add a card
twice. It survives `reset` and a filter change (a number that went back to one the page had seen
would add nothing next time), and a failed or panicked frame carries it. `decision` is present on
every committed frame, and every frame of one decision carries the view its first frame was given:

| `DecisionView` | What |
| --- | --- |
| `printing`, `oracle_id`, `label` | The decided printing, its oracle (`null` when the corpus has none) and its label |
| `outcome` | `resolved` — one printing — or `ambiguous`, a choice among printings the picture cannot tell apart |
| `choices` | Empty when `resolved`; otherwise the printings not ruled out, best first, each `{ id, oracle_id, label, distance, finishes }` |
| `replaces_previous` | Below |
| `finishes` | The finishes the printing exists in, from the corpus — `nonfoil`, `foil`, `etched` — and empty when it did not say |

**Which printing.** The card is decided by the whole-card match; the printing is then chosen
among that card's looks. Without the printing evidence (`neural_decision`) the decision is the
decided look's pictured printing when the filters admit it, else its first admitted cover; when the
filters leave more than one printing under the look it is `ambiguous`, those printings its choices
with the decided one first, each at the look's own distance. With the evidence loaded
(`evidence_decision`) the candidates are widened to the card's near looks and narrowed on two crops
of the frame — §10, *The printing evidence*. **The evidence never changes the card.**

**`replaces_previous`: a second opinion on the card the last decision named, not a second copy of
it** — so the page replaces that row rather than adding one. True when the previous decision named
the same oracle card (or the same printing, when no oracle id exists) and the card never left the
lens since: the reader changed a filter with one physical card on the mat throughout. A stretch
break (§4) or a reset forgets the previous decision, so the same card presented again is `false`
and adds; a filter change keeps it, which is the whole point of it. Asked once per decision.

**No text is read, so the finish is the corpus's**: a printing that exists in one finish takes it
on the tray row; one sold in several lands `unknown` under the Defaults' *Detect* policy
(`scanner::DETECT_FINISH`) for the reader to settle.

**Two rules on the page's side** (`useScanLoop`):

- **A pump that starts resets the session before its first frame** (#1318, 2026-10-21). Otherwise
  the session went on from whatever it held when the last pump stopped — a Stop, a view switch, a
  minimized window, *Send scan…*'s or *Add card…*'s dialog — and a card decided on the stream's
  very first frame was taken for a baseline and not added. `scanner_reset` runs first, awaited
  behind any frame still on the wire, and every decision of the stream is news — **except the card
  that was standing when the last stream stopped**: the identity (oracle, else printing) of the last
  decision a taken verdict carried, kept in window-lifetime module memory (`viewMemory`) and dropped
  by any taken frame with no quad. The stream's first decision naming it is that card still lying
  on the mat, already in the tray, and is not passed on. A start whose reset is refused says so and
  falls back to the baseline.
- **A decision that moves again within `DECISION_GAP_FRAMES` (3) frames of the last is dropped**
  (#735, 2026-10-01): a card really swapped in needs the old one lifted, the new one laid and frames
  of its own. Frames, not milliseconds, because the pump runs from about five to a dozen frames a
  second; counted from every decision, a dropped one included. The session's own `decision_seq` is
  untouched.

## 6. Filters and tokens

**Sets, a release-date range and promos, and nothing else.**
`filters::ScanFilters { sets, released_from, released_to, exclude_promos }`; set codes compare
case-insensitively, dates as `YYYY-MM-DD` strings inclusive at both ends. **A blank string is no
bound** — a cleared HTML date input sends `""`, and every date is `>= ""` while none is `<= ""`. A
printing with no release date fails any date bound. **Language is absent rather than
unimplemented** (decision 7 of
[the 2026-09-15 spec](../superpowers/specs/2026-09-15-scanner-modes-and-shipping-design.md)): a
printing's language is not something its picture says.

**`exclude_promos` leaves out every printing `cards.promo` marks** (issue #981): prerelease stamps,
promo packs, buy-a-box. The reference keeps the promos as a set beside the labels
(`Reference::is_promo`), not a flag on every label. Both faces draw it as a *Skip promos* switch
under the set picker. A sent scan does not carry it, so a replay admits promos.

**Tokens are left out of every scan by default — the session's rule, not a filter** (issue #1323).
A reader sorting a collection is not sorting its tokens, and a token that shares a card's name or
art (Ornithopter, a Treasure beside the card that makes it) is one more printing to read the card
as. `Session::set_tokens(true)` matches them, and nothing in either app calls it. A token is
`labels::is_token`; the reference keeps them as a set and the labels file carries them in its flags
byte. **`Reference::mask_without_tokens` is the mask a session searches under**, built in
`Session::new` so the tokens are out from the first frame: for empty filters `Mask::all_but` the
tokens, under filters `mask_for`'s list with the tokens off it. A reference with no token recorded
(no labels) is unrestricted.

**The mask constrains the search itself**: a look of the gallery is admitted when any printing it
stands for is (`Gallery::admit`, rebuilt on the first frame after a change), and a decision's
printings are chosen among what the mask permits — never only the answers shown.

**`Session::set_filters`**: empty filters always succeed and lift the mask (down to the tokens);
anything else needs labels and has to admit at least one printing, or it is refused with a sentence
— *Filters need card names, and the scanner has none loaded — it needs the card database.* or *No
printing matches these filters.* — keeping the filters already in force. A change forgets the card,
because votes gathered against another candidate set are votes on another question; **the filters
already in force are not a change** (`ScanFilters::same_as`), because the page sends the stored
filters every time the Scanner mounts, and a reset there wiped a decided card still on the mat,
which then decided again and was added twice. `set_tokens` answers the same way. The page disables
the Filters control when the status reports no labels, puts a refused filter back to the last one
the session accepted with the sentence inside the popover, never persists a refusal, and holds the
first frame until the stored filters have reached the session.

## 7. The checks

- **The crate's suite** — `cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir
  crates/card-scanner/target --features cli` — is a step of `pnpm verify`. CI's `rust` job runs it
  on Linux twice, at `--features cli` and with no feature (the crate as the browser's module links
  it, no SQLite), tests only (§8). `neural_mode`'s tests run the real recogniser on the
  files in git (`crates/card-neural/models/`), and drive the decision bookkeeping with reads made
  by hand; `session::tests` hold the decode bounds, the panic guard and the filters' refusals;
  `labels::tests` the format; `replay`'s tests the label reading and scoring under any feature set.
- **`host::tests::the_fence`** keeps every clock, thread, unwind and target out of the library
  (§11).
- **The page's mirror**: `packages/ui/lib/ipc.test.ts`'s `snakeMirrors` table holds every level of
  `Verdict` (and the filters) field for field against the Rust text (§9, *The IPC seam*).
- **The scan inbox's wire**: `crates/grimoire-core/src/__golden__/scan-label.txt` and
  `scan-label-no-card.txt`, asserted by the engine's suite and read whole by
  `infrastructure/scan-worker`'s (*Sending a scan to the inbox*).
- **The accuracy**: the replay (§10). It reports and does not gate.

## 8. Known gaps

1. **The crate is not `cargo fmt`-clean and carries clippy warnings** (`src/bin/replay.rs` among
   the fmt diffs; `Mask::len` with no `is_empty`, a function of eight arguments and a complex type,
   rechecked 2026-10-24). So CI runs its tests only, and the root workspace excludes it (§1).
   Adding either gate is a tidy-up commit rather than a CI change.
2. **The Neural thresholds were tuned on the scans that score them** (§10). The first scans
   received after 2026-10-15 are the honest test, against the same floor — no wrong printing, no
   wrong card.
3. **Some printings cannot be told apart at the pump's ~960 px**: of the 32 decisions left
   ambiguous on the readers' scans, 21 are a promo and a regular printing of one set, 9 are
   collector-number variants (§10).
4. **A commit can file into a stale folder when the folder list fails to load.** The page treats
   a stored `folderId` that is gone or not the reader's own as the root, but can only decide that
   once `useCollectionFolderList` has answered; if the list will not load, the stored id goes to
   `scanner_tray_commit` as it is. A deleted folder is refused in words — but an id that now names
   a **deck group** is accepted, because the import's deck arm files there on purpose.
5. **`collection_import_commit` accepts a finish the printing is not sold in.** `commit_import` →
   `add_entry_filed` checks the finish against the three-word enum and reads no `cards.finishes`,
   while the tray's per-row finish offers all three. `AddToCollection` narrows the choice; the tray
   does not yet.
6. **An ambiguous tray row's provisional name is its first choice, even when the choices span
   cards.** `tray.ts`'s `rowFromDecision` wears the best choice so the row has a picture while it
   waits. It still reads *Pick a printing* and blocks the commit, so nothing wrong is filed.

## 9. App integration

Landed 2026-09-08 against [the in-app spec](../superpowers/specs/2026-09-08-scanner-in-app-design.md).
The session glue is `crates/grimoire-core/src/scanner.rs` since the light app's step 7
(2026-10-03, [light-app.md](light-app.md) §6.10), and the commands' bodies are the core's since
step 7.3 (2026-10-07): `ScannerState::{status, frame, reset, set_filters, capture}`, `save_prefs`,
`save_tray`, `commit_tray`, `archive_tray`, and `frame_from` / `capture_from` for the body —
called from the core's command table, for a light host, and from the desktop's
`#[tauri::command]` wrappers in `apps/desktop/src-tauri/src/scanner/mod.rs`, which only fetch the
state, the webview's label and the raw request.

### The dependency

`grimoire-core` takes `card-scanner` with `corpus`, and `card-neural` with `bundled`; the desktop
and Android hosts carry the model files through it (`card_neural::bundled()`, handed to
`State.scanner.carry` as the app starts). **The `[profile.dev.package.*]` overrides are the build
root's**: the root `Cargo.toml` lists the packages that need `opt-level = 3` in a debug build, each
with its measurement in the comment above the block. Read it; a list restated in prose goes stale.

### The commands and the status

| Command | In | Out |
| --- | --- | --- |
| `scanner_status` | — | `ScannerStatus` |
| `scanner_frame` | the JPEG, as the raw body | `Verdict` |
| `scanner_reset` | — | `()` |
| `scanner_set_filters` | `ScanFilters` | `()`, or the session's sentence |
| `scanner_capture` | a full-resolution frame, its `Sidecar` in the `x-scanner-capture` header | `Captured { saved }` |
| `scanner_hold`, `scanner_elsewhere` | — | the lease (*One window scans at a time*) |
| `scanner_prefs`, `set_scanner_prefs`, `scanner_tray`, `set_scanner_tray`, `scanner_tray_commit`, `scanner_tray_archive` | | §10, *The tray* and *Scan history* |
| `scanner_submit` | a run, a printing and a finish | *Sending a scan to the inbox* |

Do not count them from this page: the command table and
`grep '#\[tauri::command\]' apps/desktop/src-tauri/src/scanner/mod.rs` answer it.

**`ScannerStatus` is `{ neural, labels, scans_dir, unapplied_filters }`.** `neural` is the
recogniser's files as one `Asset { path, present, loaded, error, source }`, `source` one of `file`,
`embedded`, `absent`, `store`: `embedded` and loaded on the desktop and Android, which build the
files in; `store` on the web, whose host composes the status itself; `absent` on a host that
carries none, where every frame answers `NEURAL_UNAVAILABLE_ERROR`. `labels` is how many came from
`corpus.db`; `scans_dir` is where a capture goes; `unapplied_filters` is the sentence a loaded
session refused the reader's stored filters with, and `null` whenever they are in force — the one
state the page cannot learn from its own pushes.

**Loading is lazy on the first command that needs the session, and happens once.** The labels come
from `corpus.db` on a connection opened `SQLITE_OPEN_READ_ONLY` for the load and dropped after —
never the shared read connection, because a 117 k-row read there queues every search behind it —
and opened directly rather than as `db::open_read`'s attached pair, because `load_labels` reads an
unqualified `FROM cards`. The printing evidence is loaded after the recogniser; a refusal is logged
and leaves the recogniser deciding without it. No labels is not a broken scanner: it recognises and
answers ids, and refuses a filter.

**A frame is the JPEG body alone.** `scanner_frame` takes it as `InvokeBody::Raw` on the desktop;
a JSON body is refused with a sentence. **`scanner_capture` is the one command with a header**:
the JPEG raw, the sidecar as JSON in `x-scanner-capture`. An `x-scanner-capture` that is **present
and unreadable** is refused, because a defaulted sidecar writes a JPEG with five empty fields and
reports success — an *unlabelled* capture the reader believes they labelled; an absent one is
`Sidecar::default()`. **The page escapes every non-ASCII character in that header's JSON as
`\uXXXX`** (`ipc.ts`'s `asciiJson`): a browser sends a header value's 0x80–0xFF as Latin-1 and
throws above that, and Rust's `HeaderValue::to_str` refuses any byte outside visible ASCII, so
`Æther Vial` would kill the call or arrive as mojibake. Both ends are tested apart — `ipc.test.ts`
pins the string `scannerCapture` produces and sweeps it with `/^[\x20-\x7e]*$/`; the Rust side reads
`Æther Vial` back out of an escaped header and refuses raw bytes — and nothing carries one string
across, which is why the rule is also written in [`packages/ui/CLAUDE.md`](../../packages/ui/CLAUDE.md)
for the next header somebody adds.

`scanner_capture` writes `live-<epoch>.jpg` and its `.json` sidecar into `data/scanner/scans/`,
created exclusively: a second capture inside the same second takes `live-<epoch>-2.jpg`, and so on
(issue #1131). It is the developer's button; *Send scan…* is the reader's (*Sending a scan to the
inbox*). A page keeps no files, so the web host refuses it.

### One window scans at a time

The process has **one** session, and since 2026-09-20 the app opens as many windows as the reader
asks for ([multi-window.md](multi-window.md)). Every window can walk to the Scanner, so the session
is held by one of them as a **lease**: `scanner::LEASE`, two seconds, and a command from any other
window is refused with `scanner::OPEN_ELSEWHERE` — *"The scanner is open in another window."*, the
same string as `verdictText.ts`'s `SCANNER_OPEN_ELSEWHERE`, pinned across the boundary by
`ipc.test.ts`.

**What a second window sees is one sentence and nothing else.** `ScannerPage` asks
`scanner_elsewhere` — which answers and takes nothing — *before* it mounts the live view, so a
refused window opens **no camera**, mounts neither `useTray` nor `useScannerPrefs`, and draws that
sentence plus *"It opens here once that window leaves the Scanner or closes."* It asks again every
`SCANNER_ELSEWHERE_POLL_MS` (one second) while the answer is yes. **The gate's query is
`gcTime: 0`**, and `staleTime: 0` is not enough: a stale `false` still in the cache is an answer,
and the view would mount the camera on it before the refetch said another window had the scanner.

**Three things renew the lease:**

- **A heartbeat while the view is mounted.** `scanner_hold` admits and does nothing else; the view
  calls it on mount and once a second after, **whatever the camera is doing** (`useScannerHold`).
  ⚠️ The frames alone were not enough: a view whose camera was starting slowly, refused or failed
  sent none, its lease lapsed, and a second window got through with the first one's tray still live.
  Every refused beat re-asks the gate.
- **The session commands** — `scanner_frame`, `scanner_capture`, `scanner_reset`,
  `scanner_set_filters`.
- **Every prefs and tray write** — `set_scanner_prefs`, `set_scanner_tray`, `scanner_tray_commit`,
  `scanner_tray_archive` — so a window whose writes have not landed keeps the scanner until they
  do. The reads take nothing.

⚠️ **An admitted command holds the lease until it _settles_.** `admit` answers a `LeaseGuard` kept
alive across the command's whole body, the awaited `spawn_blocking` included, and its drop re-stamps
the lease, so the two seconds run from completion: a tray write waits up to five seconds for the
write connection before answering `BUSY`, and a lease stamped at admission lapsed under its own
write. A drop touches the lease only if it is still that window's, and recovers a poisoned lock.

**A refusal a wait can clear is retried until the write lands**, which keeps the lease unbroken.
`refusalPasses` passes exactly two sentences, `db::BUSY` (pinned against `db.rs`) and
`OPEN_ELSEWHERE`; the next try goes out `TRAY_RETRY_MS` / `PREFS_RETRY_MS` — 1.5 s — **after the
last one answered**, inside the two-second lease. Any other refusal gets one more try and no loop,
because retrying one for ever would hold the lease for good. Only the holder mounts `useTray` and
`useScannerPrefs`, which is why a cross-window refresh may not touch the two `app_meta` rows while
they are live ([multi-window.md](multi-window.md) §4).

**On a light host the holder is always "the page"** (`scanner::PAGE`): a call through the core's
table carries no window, and needs none — Android has one window and the web host refuses a second
tab before an engine starts. There `scanner_elsewhere` answers `false` and every admission succeeds;
the lease is still taken and settles, so the page's heartbeat and retries run the same code. The
desktop passes `webview.label()` from its own wrappers and never dispatches a scanner command
through the table.

**Measured in the window** (debug, 2026-09-20): window 2's `scanner_elsewhere` answered `true` and
its page carried **zero** `<video>` elements; window 1 left and window 2 switched to the live
scanner at **+2 346 ms**, the lease plus up to one poll. With window 1 **minimized** the lease never
lapsed (340 of 340 polls over 340 s): WebView2 reports a minimized window's page as
`visibilityState: "visible"`. **So a minimized window is asked about through Tauri** (issue #556):
`useWindowParked` re-reads `isMinimized()` on the window's resize and focus events and on mount,
ORed with `document.hidden`. **The pump pauses on the minimize itself; the camera and the heartbeat
go `PARK_GRACE_MS` (five seconds) later**, so a quick restore finds the stream open and a window left
on the taskbar puts the camera light out. Focus alone pauses nothing. A fully covered window is not
seen — no event reports it.

### The IPC seam

`Core.call(command, args?: CallArgs, options?: CallOptions)`, where `CallArgs` is
`Record<string, unknown> | Uint8Array` and `CallOptions` carries `headers`; the Tauri core passes
both to `invoke`. **A light host's wire: the headers ride as the arguments** (step 7.3):

| Host | The body | The capture's header |
| --- | --- | --- |
| Desktop (`tauriCore`) | the raw IPC body, `InvokeBody::Raw` | a request header, off Tauri's `HeaderMap` |
| Android (`tableCore`, `packages/ui/lib/core/table.ts`) | base64 text in `core_call`'s `body`, decoded by the host — Tauri takes no raw body on Android | `core_call`'s `args`, `{"x-scanner-capture": "<json>"}`; a frame's are `{}` |
| Web (`protocol.ts`) | a transferred buffer | the call message's `args`, the same object |

On the last two the call is answered by the core's command table, where `scanner_frame` and
`scanner_capture` are the two entries of kind `bytes`; the entry reads them with `frame_from` /
`capture_from` — the reader the desktop's wrappers call — so the refusals are one piece of code and
the same sentences on every host.

**In a browser the session's commands are answered on the page** (step 7.5), in front of the
engine's table and in its shapes — `packages/ui/lib/core/web/scanner.ts`, over a Worker running
`crates/grimoire-scan` ([grimoire-web.md](grimoire-web.md) has the module's contract):

| Command | What the web host does with it |
| --- | --- |
| `scanner_status` | Builds the session if there is none — the labels out of the engine's Worker (`scanner_labels`), the recogniser's files from the app's origin (§10, *Where the files come from*), each buffer transferred to the scanner's Worker — and composes `ScannerStatus` from what loaded, `neural.source` `store` |
| `scanner_frame` | The JPEG's buffer transferred; the verdict is the crate's own serialisation |
| `scanner_reset`, `scanner_set_filters` | The scanner's Worker; a refusal is the crate's sentence. With no session the filters are owed to the first one built, and a reset is nothing |
| `scanner_capture` | Refused: a page keeps no files |
| the prefs, the tray, its commit and archive, `scanner_hold`, `scanner_elsewhere`, `scanner_submit` | The engine, unchanged. `scanner_hold` is heard on its way past: it is how the web host knows the Scanner is open |

**The Worker's life is the page's to manage**: made by the first command that has something to
load, ended fifteen seconds after the last `scanner_hold` or session command with nothing in flight
(the only way a WASM memory is given back), ended on a trap — whatever was in flight is refused in
one sentence — and built again by the next command, with the filters the last session held.
**Nothing posted to it is waited for without end**: each ask has a deadline (thirty seconds a frame,
two minutes a load), a watch ticks once a second while there is a Worker, and one overdue ends the
Worker as a trap does. **A build that fails is not tried again at once**: a trap under the load, an
unreadable answer or a load past its deadline sets a wait of five seconds that doubles to a minute,
cleared by a load that answers. **A read of the names the engine gave up on is not an empty
corpus**: `scanner_labels` rejects then, the status says why there are none, and the next status
asks again — which a finished card sync brings about, because `["scanner", "status"]` is one of the
entries it marks stale. The engine refuses a session command that reaches it
(`scanner::NOT_IN_A_BROWSER_YET`); nothing a reader does arrives there.

**A host that has no scanner at all says so in a sentence the page stays quiet on.** The view
matches a refused filter push against a closed list (`verdictText.ts`'s `scannerUnavailable`: the
engine's sentence, pinned by `ipc.test.ts`, and the web host's in
`packages/ui/lib/core/hostScanner.ts` — a browser without WebAssembly SIMD, a build made without the
scanner's files), so `useScannerPrefs` reports `unavailable`, **no camera is asked for and no frame
is sent**, and the sentence is drawn in the video box.

**`ipc.ts`'s scanner types keep the Rust field names, snake case**, because the verdict is the
crate's own serialisation. That is the third mirror table in `ipc.test.ts`, `snakeMirrors`, beside
the two that camel-case the Rust side, and each level of the `Verdict` tree is named in it, because
parity on the outer struct sees none of the inner ones — a renamed `best_distance` inside a standing
would leave `Verdict` agreeing while every row of the candidate table read `NaN`. `r#match` is read
as `match`, the one raw identifier in either tree; `skip_serializing_if` is deliberately not
matched, because `Verdict::error` *is* in the JSON whenever it has a value. **Both parsers split on
`/\r?\n/`**: a source with CRLF endings ends every struct in `"}\r"`, and a fence reporting a drift
that does not exist trains a reader to disbelieve the table.

### The view

`packages/ui/features/scanner/` — read the folder for its files; the ones that carry a rule:

| File | Owns |
| --- | --- |
| `ScannerPage.tsx` | The view: the Match strip over the camera, the tray beside it, and the developer column |
| `useScanLoop.ts` | The pump: one request in flight, later frames dropped, the rate over twenty round trips, `grab` for the capture (with a `catch` of its own — a throwing `drawImage`/`toBlob` outside one froze the loop with `error` still `null`), the reset on start and the decision gap (§5), and the run a Send takes |
| `useCamera.ts` | The stream: `getUserMedia`, or the reader's camera by `deviceId: { exact }` falling back to the default when it has gone; one `stopAll` every exit goes through; the wait for `loadedmetadata`. It opens nothing while its `deviceId` is `undefined`, which holds the camera shut until the stored choice has loaded. `useCameraDevices` lists the `videoinput`s, re-read on `devicechange` and once a camera is live |
| `useScannerHold.ts`, `useScannerElsewhere.ts`, `useParked.ts`, `useWindowParked.ts` | The lease's heartbeat and gate; pause at once and let go after `PARK_GRACE_MS` |
| `useScannerStatus.ts` | `scanner_status` once a session, and what a surface draws from it |
| `useTray.ts`, `useTrayLanding.ts`, `useTrayCommit.ts`, `useTrayNewFolder.ts`, `reader/` | The tray (§10) |
| `usePointAndShoot.ts` | A press's read (§10, *The tray*) |
| `Overlay.tsx` | The canvas over the video — the card the frame votes for |
| `ScannerPanels.tsx`, `panels/` | The Developer column (§10) |
| `verdictText.ts`, `reader/readerText.ts` | The pure sentence functions the panels, the strip, the tests and the stories share |
| `fixtures.ts` | The canned verdicts the tests and the stories are both driven from |

**The overlay scales its strokes with the canvas**: the canvas is sized to the video's own pixels
and the quad arrives in the *sent* frame's coordinates, so both a scale factor and a stroke derived
from the canvas width are needed. **And it carries `object-cover`, because the `<video>` under it
does**: a `<canvas>` is a replaced element whose intrinsic size is its `width`/`height`, so
`object-fit` crops it identically; without it the quad sat off the card — a 1920×1080 frame drew it
**25% too tall** in the panel column (2026-09-08). Both moved to `object-cover` on 2026-10-01; a
card at the very edge can now be read outside what the box shows.

**The row is the height, and the video box takes what the Match strip leaves.** The split answers
the view's own width through `@container/scan`, never the window's. Below 88rem the tray is a
`w-[25rem]` column with the developer panels under it in one scroller; from 88rem the camera gets two
thirds of what the panels leave, the tray the third, and the panels a 340px column of their own.
**jsdom applies no container query**, so the suite sees the narrow arrangement only. ⚠️ **A zero-basis
`flex-1` under a scrolling parent yields all its free space to a `shrink-0` sibling** — the trap the
desktop's retired narrow arm recorded, and why the phone's `CameraBox` sizes the box from the
stream's aspect instead (*On the phone face*).

**The panels' fold state is in the app store** (`scannerFolds`, `setScannerFold`), in memory only;
**`Panel` sets `aria-controls` only while the body is in the tree**, because a folded heading
pointing at an unmounted body is a dangling IDREF.

### Navigation

`ViewId` has `"scanner"`, a rail row since 2026-09-08; `switchView`'s chords are bound by index
into the rail, so Scanner's chord moves when a row before it does —
[keyboard-shortcuts.md](keyboard-shortcuts.md) has the table in force and every move.

### Storybook

`scannerHandlers(db)` answers one handler per command; its only store is the two `app_meta` rows.
`scanner_frame` is a script (`packages/fake/scannerScript.ts`, *On the phone face*). The panel stories
are driven from fixtures directly; `Scanner/Page`'s `CameraRefused` stubs `navigator.mediaDevices`
from a `useState` initializer, so the refusal is the specific `NotAllowedError`. The faults are
[`.storybook/CLAUDE.md`](../../.storybook/CLAUDE.md)'s.

### Measured in the app

All taken 2026-09-08 on Windows, in the shipped window over CDP, on the pipeline Neural replaced:
a release build's round trip was **203 ms** for a 960 px frame, 5.1 frames/s, of which the IPC and
the verdict's JSON were not the slow part; a `tauri dev` build without the dev-profile overrides was
**7 004 ms** a frame, which is why the build root carries them. The first `scanner_status` on a fresh
process, which pays the load, answered in under a second on either build. **No Neural frame has been
timed in the desktop window**: what is measured is a Worker's frame (§11, *Measured*) and the replay.

## 10. Neural, the tray and the replay

### Neural

**Added 2026-10-20; the only scanner since 2026-10-24.** A frame is handed to
[`crates/card-neural`](../../crates/card-neural/CLAUDE.md) — a corner detector and an embedder, two
small CNNs on `rten` (2.4 MB and 10.6 MB), and a gallery of 70 402 **looks** (printings that
photograph alike), 14.0 MB of int8 rows — which finds every card in the frame, fingerprints each and
searches the looks the filters admit. The agreement is §4, the decision §5. `src/neural_mode.rs` is
the session's side; the plan with the contract is
[2026-10-20-neural-scan-mode](../superpowers/plans/2026-10-20-neural-scan-mode.md). How the networks
were found, trained and compared with quickdraw.cards' is the scanner lab's record
(`E:\mtg-scanner`); `crates/card-neural/models/README.md` is the files' provenance.

**On the 124 readers' scans** (the replay, 2026-10-20, the shipped files and thresholds, before the
printing evidence, judged on the decision held after the last frame): **90.3 % printing ✓, 96.0 %
card ✓, 0 wrong cards, 4.0 % undecided** — where the removed Fast and Exact modes named the card on
42.7 % and 56.5 % of the same scans, with 13 and 9 wrong. The median decision is on frame 1; 42
decisions were ambiguous (77 resolved on the right printing and none on a wrong one), and in 118 runs
the reader's printing was the decided one or among the choices. **The thresholds were chosen by
cross-validation on these same scans** (95.2 % card ✓ held out). The five undecided are cards the
embedder does not recognise: a foil, a card under binder glare, a Japanese printing, a dark card in a
dim deck box, one plain miss.

### The printing evidence

**2026-10-21, issue #1324.** The whole-card embedder sees the card through the box
`[0.03, 0.02, 0.97, 0.72]` at 128×128: the collector band is cut off and the set symbol is a few
pixels, so reprints that share art are often one look. Two more small networks read the two places
that tell printings apart, and **never change which card is decided** — they cannot add a wrong card:

| network | reads | input | classes it was trained on |
| --- | --- | --- | --- |
| `symbol.onnx` | the set symbol, box `[0.72, 0.40, 0.985, 0.66]` (raised to include the promo-pack planeswalker stamp) | 96×128 | printed set × rarity × stamp |
| `band.onnx` | the collector band, box `[0.0, 0.80, 0.82, 1.0]` (from the card's left edge so The List's planeswalker mark is in it, wide enough for the artist) | 256×88 | one per printing face |

Both are a `mobilenetv3_small_075` body to a 64-d unit vector, trained with ArcFace; each has a
gallery of reference rows (`symbols.bin` 1.9 MB, `bands.bin` 14.3 MB) keyed by **printing**, not
look. Within one card's printings, on 3 000 cards, the nearest row is the right printing 0.950 of the
time for the band, 0.664 for the symbol and 0.965 for both — **on simulated camera views of cards 130
to 480 px tall, not on readers' frames**. The four files are 21.6 MB, and the crops come **from the
ordinary frame** (~960 px), straightened through the corners the detector found. No ablation has
separated the two crops' gains; among the 48 runs with several candidates whose truth is one of them,
the band alone ranks the truth first on 34, the symbol alone on 29, both together on 35.

The rule (`card_neural::narrow`, run by `neural_mode::evidence_decision`), for the card the agreement
decided, over the voting frames of that card the session kept:

1. **Widen the candidates.** Every look of the card whose whole-card score, averaged over the frames
   kept, is within `candidateGap` (0.04) of the decided look's is a candidate, and so is each of its
   covers the filters admit — the decided look's first, its pictured printing leading.
2. **Score each candidate** `whole + symbolWeight·symbol + bandWeight·band` (1.5 and 1), the symbol
   and band as the cosine to the printing's own row, over the frames kept.
3. **Decide a printing only when sure**: no candidate lacks a row in either gallery, and the best
   leads the second by `decideMargin` (0.20). Otherwise the decision stays `ambiguous` and its
   choices are the known candidates within `keepGap` (0.20) of the best, best first, then every
   candidate the galleries hold no row for.

The thresholds are `neural.json`'s `evidence` section, tuned by cross-validation on these same scans;
**the owner chose `decideMargin` 0.20 knowing the cross-validated estimate at the tighter 0.18 had 3
wrong printings held out**. The figures are in-sample. *Resolved right* names exactly the reader's
printing; *resolved wrong printing* another printing of the right card; `printing ✓` is not the
measure, because an ambiguous decision whose first choice happens to be the reader's scores it too.

| Neural pass, 124 scans | resolved right | resolved wrong printing | ambiguous | choices (ambiguous) | card ✓ | truth decided or in choices |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| before (2026-10-20 files) | 77 | 0 | 42 | median 2, mean 2.24 | 119 | 118 |
| with the evidence | **87** | **0** | **32** | median 2, mean 2.09 | 119 | 118 |

**The 32 left**: 21 are a promo and a regular printing of one set (mostly the prerelease `s`, whose
2021+ datestamp sits outside both crops), 9 are collector-number variants of one set (the digits are
too blurry at ~960 px), and 2 are in different sets. The final replay of 2026-10-21 (`af2951d2f`)
matched these figures exactly; its `printing ✓` fell 112 → 110 on placeholder order alone, since the
tray never files `choices[0]` of an ambiguous decision (`unresolvedCount` stops the commit until the
reader picks). A sharper frame is the way on for the 9: the design's follow-up cuts the crops from a
larger frame once the scan inbox stores one.

### Where the files come from on each host

**Eight files in git, in two sets** (`crates/card-neural/models/`): the recogniser's four
(`detector.onnx`, `embedder.onnx`, `gallery.bin`, `neural.json`) and the evidence's four. There is
nothing else to ship: the labels come from the host's own `corpus.db`.

| Host | The recogniser | The evidence |
| --- | --- | --- |
| Desktop, Android | compiled in — `card_neural::bundled()` in `scanner::Embedded::neural` | compiled in — `bundled_evidence()` in `Embedded::neural_evidence` |
| Web | fetched from the app's own origin, `/scanner-neural/<set>/` (`packages/ui/lib/core/web/scanNeural.ts`, `assets.ts`' `NEURAL_*`), the first time a Worker needs them | the same, after the recogniser's, in the background with no frame waiting; a failed fetch leaves the recogniser deciding without it |

**Built in or nothing on a native host**: no file in `data/scanner/` overrides them, since the four
are one set (the gallery is the embedder's own and the thresholds were tuned on the pair) and a new
set is a rebuild. **On the web the address names the set**, so the HTTP cache keeps each a year and
the service worker keeps it in the scanner's Cache Storage the first time it passes; the page keeps
nothing itself, and a Worker made again is posted the files again from those caches with no network.
Each file is fetched one at a time and held to the length the build measured (`VITE_NEURAL_BYTES`),
so a host that answers an unknown path with a page, or a cut-off body, is refused in a sentence and
no Worker is handed part of a network; each answer and chunk is bounded in silence.

**The monthly retraining remakes the seven network and gallery files and never `neural.json`**: its
thresholds, the evidence's too, are the owner's. A retrained crop network can shift its score scale,
so the delivery's pull request is replayed on the readers' scans before it merges.

### The tray

**Two `app_meta` keys, each one JSON value written whole: `scanner_prefs` and `scanner_tray`.** No
schema rung, and neither is synced: the prefs are about the device in the reader's hand, and a tray
reaches another device only once committed, as ordinary collection rows. Both writes go through
`sync::with_write`, so **both answer `BUSY` while a sync holds the write connection**;
`set_scanner_tray` also refuses more than 5,000 rows and any row under one copy. A stored value that
does not parse reads as the defaults or an empty tray. `ScannerPrefs` is the filters, the finish and
condition a new row starts with, the folder, the Developer switch, the camera (`cameraId`, the
webview's `deviceId` — a fact about this computer), the tray's layout (`trayLayout`, `grid` or
`list`, any other word read as the grid) and `pointAndShoot`, all under `#[serde(default)]`, so a row
an older build wrote — one with a `mode`, from before 2026-10-24 — reads with the rest intact. **A
tray row records no language.**

**The TanStack cache is the tray, and a refused write keeps it on screen.** `useTray` holds the rows
in `["scanner", "tray"]` with `staleTime` and `gcTime` both `Infinity` and `structuralSharing` off, so
`latest()` hands back the very row objects the last write passed in. It writes after 400 ms of quiet
and on unmount; on a refusal it keeps the rows and rewrites the whole tray on the next change, and the
two sentences `refusalPasses` admits loop every 1.5 s until a write lands (§9). `useScannerPrefs`
does the same. **Every tray write is single-flight, the commit included**: one queue per query
client, so writes reach the backend in the order they were asked for. **Every writer builds on the
tray as it is** (`tray.latest()`), and `TrayPanel`'s `onRows` takes an updater, never an array.

**Newest first, and a bump is the newest row only.** A decision lands at index 0. A resolved decision
bumps the newest row instead **only when that row names the same printing, has no pick pending, and
is in the finish a new row would start in** — the collection's grain includes the finish. An
**ambiguous** decision becomes a row carrying every candidate as small whole cards to press, wearing
the first provisionally (§8 item 6); the camera keeps running while it waits, and *More printings…*
opens the app's all-printings dialog with a `pick` that hands the printing back. **A card that lands
takes the tray back to its top** (issue #1320, `tray.ts`'s `headLanded`, heard through
`reader/useHeadLanded.ts`).

**A decision that `replaces_previous` replaces the newest row instead of adding one** — but only when
that row is the same oracle card, both ids known, or the same printing when both oracle ids are absent
(#742). It keeps the row's key, quantity and finish and takes everything that says which printing
from the decision. A newest row of another card gets an ordinary add. The strip and the card over the
camera say *Printing updated*, never *Added*.

**The commit is one `scanner_tray_commit(items, folderId, remaining)`**: the collection import in
`add` mode **and** the tray that is left, in one transaction (`collection::commit_import_with`), so an
app closed before a debounced tray write cannot leave committed rows in the stored tray. One condition
for the whole commit, from the Defaults popover; finish is per row. **All or nothing**: a refusal keeps
every row and puts the backend's sentence above them; a success removes **only the rows it
committed**. `remaining` and the lines are worked out when the commit actually goes out and again when
it answers, because the camera keeps running — a second press over rows a first press took finds them
gone and sends nothing. It invalidates `OWNED_WRITE_KEYS`. **A stored folder that is gone or not the
reader's own is the root** (§8 item 4).

**`Clear all…`** (issue #738) asks first, in a `ConfirmDialog` mounted as a sibling of the
`@container/scan` box (a container is the containing block for a `fixed` scrim), and clears the rows
it asked about — the commit's own `withoutCommitted` against a snapshot taken when the dialog opened.

**Two layouts, a grid of card tiles and the list of rows**, switched in the header. **Every tray
picture is the whole card, never the `art` crop**: a crop has no printed frame and so no artist credit
([`packages/ui/CLAUDE.md`](../../packages/ui/CLAUDE.md)'s art-credit rule), and what tells two printings
apart is the frame. A waiting row spans the grid (`col-span-full`) with its candidates on the grid's
own column template (issue #1004).

**Every resolved row carries one copy's price at the reader's marketplace** (issue #736): one
`printing_prices(cardIds, marketplace)` read for the whole tray under `["cards", "prices"]`, the row's
own finish (`reader/trayPrice.ts`; for `unknown` the chain `nonfoil → foil → etched`). A row waiting on
a pick asks nothing and draws nothing; a unit price, never the row's total; an em dash when the
marketplace does not quote that printing in that finish.

**The Match strip above the camera is the reader's whole view of the session** (`readerText.ts`'s
`matchStrip`, drawn by `reader/MatchStrip.tsx`): a pill, the card's name and printing, one sentence and
a bar, and none of the developer vocabulary. **The row is the live region** (`role="status"`, *Scanner
status*), with the name `aria-hidden` while the tone is *progress*, because the leader can change frame
to frame. **The Matched name is the tray's row**, and that rung asks for `verdict.decision`, so a
committed frame with no decision cannot call the last card matched over the one in the camera. An
ambiguous decision names the card only when every choice shares one name.

**Start scanning / Stop scanning** (issue #774): the view opens stopped (issue #1317) — the camera
comes on and nothing is read until the press. Stop pauses the pump while keeping the preview and the
tray; a frame still being encoded is discarded, and an in-flight answer cannot add to the tray.
**Point and shoot reads for the length of a press** (2026-10-22): Neural decides on one clear frame,
so a camera carried from one card to the next filed whatever passed under it. With
`ScannerPrefs.pointAndShoot` on, **a click of _Scan card_ on the desktop face** runs the pump until one
card lands, and **a hold of _Scan_ on the phone face** reads while a finger is on it (Space holds it
from a keyboard; an Enter or an assistive tech's activation is one card's shot). What a press does is
`usePointAndShoot.ts`, shared by both pages: every shot is news (it starts with `clearReads`, so a
second copy laid where the first lay is filed); a shot never outlives what pauses the pump; and *Send
scan…* is offered during a shot only.

**_Reset evidence_ sits at the bar's end, for every reader** (issue #740), outside the live region.
**Reset is a boundary for outstanding frames too** (issue #781): the pump clears its verdict,
invalidates any unfinished grab or answer, drains the outstanding frame and only then calls
`scanner_reset`, because the host's blocking tasks can take the session mutex in either order. The
tray stays intact, and the decision gap is cleared.

**A card that lands is laid over the bottom of the camera for 2.2 s** (`reader/AddedToast.tsx`,
`LANDED_HOLD_MS`) — its picture, a tick, the name, the set, number and finish, *Added again ×N* on a
bump, *Printing updated* on a re-read, the first two candidates fanned for a pick — and closes its
line with a price (issue #1321, `reader/useLandedPrice.ts`: the card's figure, or the span across a
pick's candidates). It is `aria-hidden`, since the strip says the same.

### Scan history

**Every pile the tray puts away is kept** (issue #989, 2026-10-14). The tray empties two ways that
keep its cards, and each writes **one batch** (`crates/grimoire-core/src/scan_history.rs`, user
schema v65's `scan_batches` and `scan_batch_lines`):

- **Add to collection** records a `filed` batch **inside `scanner_tray_commit`'s own transaction**,
  so the history can never name a pile the collection did not take. It keeps the folder's id and its
  name, and the one condition the press filed at.
- **Archive** is the commit without the collection: `scanner_tray_archive(items, remaining)` records
  an `archived` batch and stores what is left of the tray in one savepoint. It takes the rows Add
  would (`commitPlan`), goes through the same single-flight queue, holds the lease, and invalidates
  `["scanHistory"]` and not `OWNED_WRITE_KEYS`.

**A batch is a record, not a tray**: lines folded to one per printing and finish, named `Scan N`,
carrying the printing's name, set and number beside the soft `card_id`. The history's own writes are
`scan_history_rename` and `scan_history_delete`, which never touches the collection. *Clear all…*
keeps nothing, and with a trade `destination` neither Archive nor History is drawn. **History** on the
bar opens `ScanHistoryDialog` (`features/scanner/history/`), under one `["scanHistory"]` root; its
delete question is a `Dialog` at `layer="stacked"`. Neither table syncs and the mirror writes neither.
On the phone face both are rows of the tray footer's `⋯` sheet, and the history is
`scanner/HistorySheet.tsx`, an `ActionSheet` whose question is a page, not a second dialog.

### The Developer switch

**The panels sit behind a Developer switch at the end of the bar, stored in `scanner_prefs`.** Off,
the column beside the camera is the tray alone; a loop failure and a refused reset are still drawn for
everyone. On, the developer column holds what a verdict carries — the candidates and their distances,
the agreement's standings, the timings — and **Add frame to dataset** (`scanner_capture`). Every panel
starts closed; Match has no fold. The phone has no Developer switch.

### The replay

`replay` (`crates/card-scanner/src/bin/replay.rs`, feature `cli`; the label reading and scoring in
`src/replay.rs`) feeds the scans readers send to the scan inbox through fresh sessions and scores them
against the printing the reader named. Their finish is a breakdown, never scored. Those frames are the
only labelled camera frames there are. It reports and does not gate: exit 0 for a run that finished
whatever the accuracy, 1 when nothing could be replayed.

```text
replay --corpus-dir <dir> --corpus <corpus.db> --out <dir>
       [--commit <sha>] [--only <text>]... [--jobs N]
       [--neural-models <dir>] [--neural-evidence <dir>] [--neural-evidence-meta <json>]
```

**Two passes a run, a fresh `Session` each**: **As scanned**, under the label's filters, and
**Neural**, unfiltered. Every frame is fed in order, and **a pass ages its votes by the label's own
frame times** (`run[].ms`), installed as the session's clock (`host::set_clock`), so no wall clock
decides anything and a run answers the same on a loaded machine. A scan sent while the scanner had
other modes (the label's `scanner.mode` says `fast` or `exact`) is replayed all the same: the frames
are what the camera saw. **A pass is judged on the decision the session holds at the last frame**,
since the label names the card in the last frame:

| Score | When |
| --- | --- |
| `printing` | the decided printing is the reader's |
| `card` | another printing of the same oracle card |
| `wrong` | another card, which the result names |
| `undecided` | no decision by the last frame |
| `error` | a frame the scanner failed on: a panic, an undecodable JPEG, a failed read |

A pass also records `settled` (`right_printing`, `wrong_printing`, `ambiguous` or `other` — a decision
that offered a choice is `ambiguous` whatever its first choice scored), `choices`, whether the truth
was among them, `first_decision_frame` and `decision_frame` (1-based) with `decisions`, and per frame
`ok`, confidence, best distance, the printing decided by then and any error. **With the evidence
loaded, each pass records `evidence`**: every candidate printing of the last decision, its look, its
whole-card, symbol and band scores (`null` where the galleries hold no row, or no crop was read), and
the printing the evidence decided.

**The models are `crates/card-neural/models/`**, or `--neural-models`. The evidence is
`--neural-evidence <dir>`, or — left out — the models' folder when it holds all four files and its
`neural.json` has an `evidence` section (the folder in git does), and `--neural-evidence-meta` reads
another `neural.json` in place of the models' own (how the lab tunes the thresholds without copying
files). The log says `neural evidence: <dir>` or `none`.

**`results.json` is schema 2** (since 2026-10-24): `{ v, commit, runs, skipped }`, each run
`{ id, received_at, card, finish, platform, version, mode, filtered, frames, known, then,
decided_differs, then_frames, passes }`. **A replay is not the scan, two ways**: nothing came before
the run's first frame, and a run kept at full resolution is brought down to the pump's size again
(`replay::as_sent`, 960 px at quality 72), a resample of the scanner's picture and not its bytes.
**`then` is the label's own `scanner.reported`, scored the same way**, and `decided_differs` counts the
frames where the replay's decision differs from the label's — together, how far a replay strayed from
the scan apart from any change to the scanner. **A scan the reader sent with no card in it is skipped**
by name (`replay::NO_CARD`): nothing scores a false positive yet. The files are numbered from 00
(`frames/<id>/00.jpg`); every frame number in the results counts from 1.

**Where the scans live, and what enters git.** `pnpm scanner:corpus pull` copies each complete pair
from the inbox bucket to the private corpus bucket `mtg-grimoire-scan-corpus` and mirrors it to
`.scanner-corpus/` in the main checkout (`SCANNER_CORPUS_DIR` overrides): `labels/`, `runs/`,
`frames/{id}/NN.jpg`, `baselines/` and `out/`. **Nothing of it enters git**: the frames are readers'
photographs, and an id is the handle a deletion request has, which history could not honour. Only the
summary's aggregate table belongs in this document. Before it copies a pair the sync checks that the
label parses, that its frames' `bytes` add up to the run and that each frame is a JPEG; it reads every
copy back by size; it takes ids only of `[A-Za-z0-9_][A-Za-z0-9_-]*`; and it **refuses to prune the
mirror when the corpus bucket lists as empty beside a non-empty mirror** — that reads as an unreadable
bucket, so a full, deliberate purge is refused until the mirror folder is removed by hand. `--drain`
deletes from the inbox every pair whose copy in the corpus has the same two sizes, and is the owner's
to run.

**A deletion request names an id.** `pnpm scanner:corpus remove <id>...` deletes the inbox's label and
run, the corpus's, the local pair, the last report and the id's rows in every baseline, here and in the
corpus bucket — a dry run until the owner adds `--yes`. **Bad or mislabelled scans** are removed the
same way, picked from the report (tick the rows in `report.html`, *Copy remove command*): a mislabelled
scan is deleted, never relabelled. **A baseline name is written once**: a pull does not re-upload a
baseline that changed by hand, but reconciles every local one against the corpus, dropping the rows of
scans it no longer holds; a failed upload waits in `baselines/.pending.json`.

```text
# R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment
pnpm scanner:corpus pull [--drain]
pnpm scanner:replay [--baseline <name>] [--save-baseline <name>] [--only <text>]...
```

`scanner:replay` finds `corpus.db` in the main checkout, builds the binary in release, replays the
mirror and writes `results.json`, `summary.md` and `report.html` into `.scanner-corpus/out/`.
`scripts/scanner-replay/` computes every count once and both the summary and the page read it; the
summary's columns are `pass`, `n`, `printing ✓ %`, `card ✓ %`, `wrong card`, `undecided %`, `errors`,
`resolved right`, `resolved wrong printing`, `ambiguous`, `median choices`, `mean choices` (both over
the ambiguous decisions only), `median frames` and `decided then lost` (undecided passes that had made
a decision). The page draws, per scan, the frame strip, the expected card and each pass's answer.
`--save-baseline` takes a name of letters, digits, `_`, `.` and `-`, not starting with a dot.

## 11. The host seam — one thread, no clock, nothing to catch

Landed 2026-10-07, as step 7.1 of the light app's phase 7
([#761](https://github.com/Msgaihede/mtg-grimoire/issues/761)). A browser's Worker breaks three
assumptions a desktop holds: it is one thread, `Instant::now()` **panics** on
`wasm32-unknown-unknown` at run time in a build that compiled without a warning, and the web module
is built with `panic = "abort"`, where a panic is a trap.

**`crates/card-scanner/src/host.rs` is the one file that knows the machine**:

| | A native host (the desktop, Android) | A Worker |
| --- | --- | --- |
| `Stopwatch` | an installed clock, else `Instant` | an installed clock, else **zero** |
| `guard` | `catch_unwind` | nothing: below |

**The scanner runs on the thread that hands it a frame, on every host: nothing in this crate spawns.**
(The pipeline Neural replaced fanned its detectors, hashes and reads out over threads through `host`;
those helpers went with it on 2026-10-24.)

**The clock: an installed one wins, otherwise `Instant` where the target has one, otherwise zero.**
`host::set_clock(fn() -> f64)` takes milliseconds on anything monotonic, once per process.
`grimoire-core`'s `ScannerState::new` installs `platform::clock::monotonic_ms` — `Instant` natively,
`performance.now()` in a Worker — and the replay installs the label's frame times. **Every reading is
telemetry, ending in an `_ms` field, except the agreement's**, whose votes age by it (§4). On a host
with no clock every frame is at zero, so no vote ages and no gap is too long; a frame with no card
still resets the count, so it still decides, only more leniently.

**⚠️ `host::guard` guards nothing where a panic aborts**, and that is not something this crate can
fix. With `panic = "abort"` the panic is a trap, the export never returns, and `PANIC_ERROR`'s verdict
is never built. Provoked rather than assumed (headless Chrome 154, 2026-10-07): a panic inside the
session surfaced in the Worker as `RuntimeError: unreachable` thrown out of the call, after the
module's panic hook had written the panic's sentence to the console, and **the next frame asked of the
same instance trapped as well** — `RefCell already borrowed`, because nothing ran the borrow's
destructor. **Containing it is the host's, and the only containment is a new instance**: the Worker
thrown away and the labels and files loaded again (§9, *The IPC seam*). A host that keeps the session
behind a `Mutex` meets the same thing one line later, and an instance that is also the engine would
take the databases with it — the argument for the scanner being a module of its own.

**The fence is `host::tests::the_fence`.** It reads every `.rs` file under `src/` at any depth but
`host.rs`, up to the file's first column-0 `#[cfg(test)]` that gates a module, skips comment lines,
and refuses `Instant`, `SystemTime`, `UNIX_EPOCH`, `catch_unwind` and `resume_unwind` as whole words,
`std::thread` and `thread::` as written, any `cfg` that names a target (`target_…`, or a bare
`windows`, `unix` or `wasm`, however many lines rustfmt broke it over), and **three ways of waiting**:
a channel's blocking `.recv()`, a `Condvar` and a `Barrier` — each a wait for another thread, which on
a host with one is a wait for ever. `src/bin/` is outside it, and so is test code. **A test module has
to be the last thing in its file**, because the sweep stops reading at one: code found below the module
it cut at is a failure of its own. **It is a list of spellings**: a thread reached through an alias or
another crate passes it, and what the dependencies do is not its to see.

### Measured

**The Neural scanner in a Worker's module** (2026-10-21): the built `dist-wasm/scanner` module
(`simd128`, the `wasm` profile) in **Node 24's V8 on the owner's desktop**, loaded through its own
`initSync` and fed readers' JPEG bytes — not in a browser and not on a phone; ten readers' runs (every
twelfth of the 124, 20 frames each), `reset` between runs, a warm-up pass discarded, two runs of the
whole, which agreed. The `load` row carried the then-current hash bundle and OCR models as well, so the
module's memory today is lower by their share, not re-measured:

| step | linear memory | time |
| --- | ---: | ---: |
| `load` (with the removed bundle and models) | 42.1 MiB | 41 ms |
| `load_neural` | 64.4 MiB | 39–40 ms |
| 200 frames, no evidence | 64.4 MiB | mean 43.7–44.8 ms, median 42–43, p90 59–60, max 102–109 |
| `load_neural_evidence` | **90.3 MiB (+25.9)** | **48–49 ms** |
| 400 frames with the evidence | 90.3 MiB | mean 44.3–45.4 ms, median 42–43, p90 59–63, max 94–116 |

The evidence costs **25.9 MiB** — its 20.6 MiB of files and ~5 MiB of the band index and the two
networks' working space — and a frame no measurable time. Both are under the bar the review set
(40 MiB, or a 2 s hand-over) for counting a trap after the evidence loaded against the evidence, so a
trap is still the frame's and the next Worker gets the evidence again. A phone's V8 is slower than
this desktop's, perhaps several times; the 25.9 MiB does not change with the CPU.

## Creating a deck from the review tray

The tray's **Create deck…** action opens the same full settings dialog as the Decks gallery (issue
#737). It captures the reviewed rows at the press, so later scans do not change the list being created.
Every row must have a chosen printing and a known finish; quantities, editions and finishes travel into
the new deck's Actual list. `useScannedDeck` reads the printings' type lines and Oracle Tags and applies
`autoCategoryFor` to each row; the existing deck import command writes the categories and cards in one
transaction, and if it fails the hook deletes the new deck and reports the original refusal. The scans
stay in the tray: creating a deck writes its list, and **Add to collection** records ownership.

## Adding a card by hand

**A card the camera will not read can be searched for and put in the tray by hand** (issue #978,
2026-10-14): **Add card…** in the tray's header on both faces opens `AddCardDialog`
(`reader/AddCardDialog.tsx`).

- **The same two questions *Send scan…* asks**, through the same parts: `PrintingPicker` and
  `FinishRadios`. A printing sold one way settles its finish; under *Detect* the reader answers, so a
  hand-added row is never `unknown`.
- **The scanner pauses while the dialog is open** (`useScanLoop`'s `live` gate): a card read behind the
  scrim would land in a tray the reader cannot see. Closing it resumes exactly what was running.
- **The row is `tray.ts`'s `addPicked`**: settled, newest first, bumping the newest row by
  `addDecision`'s rule, and landed with a scan's marks. No toast: the tray is staging.

## Sending a scan to the inbox

**A reader can send a scan — the last couple of seconds of frames the scanner was given, with the exact
card they show — so the scanner can be tested against it** (issue #776, 2026-10-11). It is how the
replay's corpus is made.

**A scan is a run of frames, never one picture** — the owner's rule: *all the frames or nothing at all;
we don't want a single screenshot*. The agreement is about what happens *across* frames, and one still
says none of that. What is sent is the frames the scanner **was** given, in order, each beside what it
answered — **at full resolution** (the owner's decision, 2026-10-22: a picture can always be brought
down later, never up). On a device that may send, the pump draws each video frame once at up to 1920
pixels wide (`EVIDENCE_MAX_WIDTH`), makes the scanner's smaller frame from that same draw, and keeps the
large one for the run. It is the whole run or nothing on every layer — the page opens no dialog on fewer
than five frames, the engine refuses a run that short before any request, and the inbox has no shape a
single picture fits.

**It is the Scanner view's own, never offered over a trade**, and **it is a supporter's** (the owner's
decisions, 2026-10-11). The press is drawn only where the membership reads active or in grace
(`submit/useMaySendScans.ts`); the engine refuses any other device before it reads a picture and sends
the relay's token with the scan; and the inbox verifies that token first
(`infrastructure/scan-worker/src/auth.ts`). **Where the press is not drawn, nothing is** — no greyed
button, no sentence: the phone page is the one Google Play distributes, and it may not lead a reader to
a membership bought elsewhere. The engine's three sentences (`NOT_ON`, `UNCONFIRMED`, `NOT_ACCEPTED`)
name no membership, and a test holds them to it.

**It takes two presses.** The first freezes the run and opens a dialog; the reader looks through the
pictures, chooses **the exact printing** and **its finish** by hand — or says **there is no card in the
picture**, which sends the run with neither — and the second press sends. **Nothing is pre-selected**:
the search starts from the name the scanner was leaning towards, but a default the scanner filled in
would be the scanner grading itself.

### The run

`useScanLoop` keeps the last frames its pump sent, in a ring (`recent()`, `submit/run.ts`):

- **Only frames whose verdict the page took.**
- **At most twenty frames and eight megabytes** (`RUN_MAX_FRAMES`, `RUN_MAX_BYTES`), the oldest dropped
  first; fewer than five (`RUN_MIN_FRAMES`) is not a scan, and the press says *Not enough of the scan
  yet…*. `ipc.test.ts` holds the frame counts to the engine's and the byte budget under its 10 MB.
- **Never across a break**: the ring is emptied by `clearReads`, `reset`, a pump starting or stopping,
  and a filter set the session accepts (`breakRun`), so every frame of a run was judged under the
  filters the label names. A press that lands in the round trip between the session taking a new filter
  and the page hearing it can send the last frame or two under the old filter's name.
- **Never older than four seconds** (`RUN_MAX_AGE_MS`), at the ring and again at the press.
- **A copy of each frame's bytes, taken before the call**: the web host *transfers* a frame's buffer to
  its Worker, which leaves the page's array detached the moment `scanner_frame` is called.
- **In memory only**, and gone when the pump stops. The privacy policy says so (*The camera*).

A press reads the ring and the page's state in one synchronous step (`useScanSubmit`). **Recognition
pauses while the dialog is open** (issue #977); the camera stays open, and closing it starts a fresh run.

### What is sent

| | From | Notes |
| --- | --- | --- |
| The frames | the ring | Five to twenty JPEGs, oldest first, end to end in the request's body |
| `card` — id, set, number, language, name | **the engine**, from `cards`, by the id the reader chose | The page sends the id alone. It is the card in the **last** frame |
| `finish` | the reader | Refused when the printing is not made in it |
| `scanner.reported` | the run's last frame | The printing the session had **decided** on (`decision.printing`), else `null` — never a standing's id |
| `scanner.mode`, `confidence`, `distance`, `bundle` | the last frame, and the engine | `mode` is always `"neural"` since 2026-10-24 and `bundle` always `null`; the label keeps both fields, and its `LABEL_VERSION`, for the inbox's sake |
| `scanner.filters` — sets, from, to | the filters the session last **accepted** (`useScannerPrefs`' `inForce`) | A replay without them is another scan. Set codes in lower case, at most 64 |
| `run[n]` — `ms`, `bytes`, `width`, `height` | the page's clock; the engine, from each JPEG's header | `ms` is milliseconds before the press, zero or negative. `bytes` is where the next frame starts: **`run` is the body's only index** |
| `run[n]` — `ok`, `confidence`, `distance`, `decided` | that frame's verdict | Whether it found a card, the agreement's confidence after it, the best distance, and the printing decided by then |
| `run[n]` — `lock`, `detail` | the engine | Always `null` and `false` since 2026-10-24: the quad lock and the detail frame are gone, and the inbox's shape keeps the fields |
| `app` — version, platform | the engine | `desktop`, `android` or `browser` |

**Nothing in it says who sent it** — no device id, no group, no account — and the inbox stores no
address and keeps no log. The privacy policy (`apps/light/public/privacy.html`, *Sending a scan*)
promises that; a field added to the label is a sentence owed there. The inbox answers an id, shown as
the reference: the only handle a deletion request has.

### The path

`ipc.scannerSubmit(submission)` → the engine's `scanner_submit` (`crates/grimoire-core/src/scanner_submit.rs`)
→ `POST /scan` on the scan inbox (`infrastructure/scan-worker/`).

- **A `task` in the command table, with the pictures as base64 inside its one argument** — not a
  `bytes` entry, whose body runs on the blocking pool where a request cannot be awaited.
- **Every host sends it the same way**, the web app included: a cross-origin `fetch` the inbox answers
  for the web app's origin, named in the hosting policy's `connect-src`.
- **Every refusal the engine can make, it makes before any request**, each refusing the whole
  submission: too short, more than twenty frames or over 10 MB (never trimmed), a frame that is not a
  JPEG, a printing this install lacks, a finish the printing is not made in, a card without its finish
  or the reverse. What the inbox refuses is reworded by status or `code`.
- **The body is the frames end to end, as `application/octet-stream`**; the label crosses beside it as
  ASCII JSON in the `x-scan-label` header, under a cap of 8192 the engine bounds its fields to fit.
- **The wire is held from both ends.** `scan-worker`'s `label.test.ts` reads the engine's label structs
  as text; `wrangler.test.ts` holds the address, the run's bounds, the header's name and cap, the content
  type and the refusal codes; and `crates/grimoire-core/src/__golden__/scan-label.txt` is asserted by the
  engine's suite and read whole by the inbox's.
- **The inbox's bounds** are `infrastructure/scan-worker/README.md`'s, with the deploy and the lines that
  cut a stored run back into its frames.

The developer panel's **Add frame to dataset** (`scanner_capture`) is a different thing: one full-size
frame to a file beside the app, on a host that keeps files. Send is for a reader, works where there are
no files, and takes a printing rather than a string.

## On the phone face

The light app's phone face (below 1024px; [light-app.md](light-app.md)) has the scanner since
2026-10-07: `apps/light/phone/pages/ScannerPage.tsx` and `apps/light/phone/scanner/`. **The desktop
reader's parts in the phone's idioms** — nothing about how a card is recognised, landed or filed is
written a second time.

### What is shared

Everything that decides: the camera (`useCamera`, `useCameraDevices`), the pump and its one add per
card (`useScanLoop`), the tray and the prefs (`useTray`, `useScannerPrefs` — the same two `app_meta`
rows, so a tray scanned on one face is the tray on the other), the lease (`useScannerHold`,
`useScannerElsewhere`), the status (`useScannerStatus`), the landing and the commit (`useTrayLanding`,
`useTrayCommit`), point and shoot (`usePointAndShoot`), *Create deck…* (`useScannedDeck`), the reducers
in `reader/tray.ts`, the sentences in `readerText.ts` and `verdictText.ts`, and `Overlay` and
`AddedToast` as they are.

### What is the phone's

The arrangement, because each of the desktop's is built for a pointer and a wide view.

| Desktop | Phone | Why |
| --- | --- | --- |
| `ScanBar`: anchored popovers, a *Point & shoot* switch and a Developer switch | `ScanControls`: *Stop scanning* (or, under point and shoot, *Scan* held) and one press opening `OptionsSheet` — Scanning, Filters, Finish, Condition, Camera as pages of one bottom sheet | An anchored panel has nowhere to be anchored at 360px. The Camera row is drawn only with more than one camera. No Developer switch |
| The video is a `flex-1` box in a column that is the view's height | `CameraBox`: the column's width at the **stream's own aspect ratio**, 4:3 until a stream reports one, capped at 38dvh (60dvh from 720px) | The page is a scrolling column, where a zero-basis grow collapses to nothing (§9, *The view*) |
| `MatchStrip` on one row | `MatchLine`: the pill, name and printing on one line, the instruction on the next | At 330px one row has no room for a name |
| `TrayPanel`: a grid or a list; 28px controls; tooltips | `Tray`: rows; the printing and the finish are 44px presses opening sheets; a 44px stepper; a waiting row is its candidates as whole cards three to a line | A 44px finish and stepper do not fit under a 156px tile, so `trayLayout` is left unread |
| *More printings…* opens `AllPrintingsDialog` | A sheet of the card's printings (`cardPrintingsKey`), each a press calling `setPrinting` | The choice carries the printing's `finishes`, so a printing sold one way settles an `Unknown` row |
| The tray's footer and header presses; *History* on the bar | `TrayFooter`, outside the page's scroller: the destination press, a `⋯` sheet (*Archive*, *Create deck…*, *Clear all…*, *Scan history*), and Add | **A refusal is words on the page**, never a tooltip |
| `useWindowParked`: Tauri's minimize | `usePageParked`: the document's own visibility, released from its first render on a page that mounts hidden | A phone reports a hidden page, which WebView2 does not |
| A host with no session draws its sentence where the picture would be | The same, in `CameraBox`; the status line is not drawn and the Filters row is refused with the sentence | No camera is asked for and no frame sent; the tray still reads, edits and files |

**From 720px wide** the camera's column and the tray's stand side by side, each scrolling by itself:
a 22rem tray, the camera the rest. It asks the viewport, not a container, because the page's sheets are
mounted inside it. **Not from 600px**, the rail's breakpoint: measured there, the tray was a 288px
column beside a camera 200×113.

### The fake's session is a script

`packages/fake/scannerScript.ts`. One card is thirteen frames — three with nothing in frame, four
weighing, the one that decides, five held with the same number — answered `FAKE_FRAME_MS` (110 ms)
apart. The pile is five, in the Storybook corpus's own printings: Urza's Saga, Urza's Saga again (a bump
to ×2), Ancient Tomb, Black Lotus, and a last card that exercises an `Unknown` finish and a row waiting
on a pick. After the pile the desk is empty; `scanner_reset` lays it down again and `decision_seq` keeps
its value, as the crate's does. It does not apply the filters, or report a quad that has anything to do
with the picture.

**It is the fake's first slow handler, and it found a hole in the fake**: a frame still on the wire
when a test ended settled in the *next* test and took the pointer to the finished test's world with it.
`invoke` now re-points only while the world is **standing** (`scope.ts`), and `world.test.ts` stages a
slow call settling after its world was replaced.

### Measured, 2026-10-07

`pnpm mobile:scanner-smoke` (`scripts/phone-scanner-smoke.ts`), headless Chrome with
`--use-fake-device-for-media-stream` under a touch pointer, against `mobile:dev` — the Storybook fake,
not the engine. At 360×800 and 412×915 the camera's box on the fake 1920×1080 stream was 328×185 and
380×214; the footer stayed over the tab bar with 5 rows and with 40; no control was under 44px; nothing
scrolled sideways. On its side, 800×360, the two columns stood side by side with nothing under 44px.
**Not seen**: a real lens, a real phone, the engine.
