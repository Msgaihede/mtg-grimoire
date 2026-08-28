# The Rust core in a browser — a spike, live-verified

**Measured 2026-08-27** on Windows 11 (26200). Every wasm figure is a **release** build of
`wasm32-unknown-unknown`, driven over CDP. Two machines:

| | |
| --- | --- |
| **Desktop** | Chrome 151.0.7922.174, headless, this workstation |
| **Android** | OnePlus 12 (`CPH2581`), Snapdragon 8 Gen 3 (`SM8650`), arm64-v8a, Android 16 / SDK 36, 15.6 GB RAM, Chrome 151.0.7922.173, reached over `adb reverse` |

> ⚠️ **The phone is a flagship, not the "mid-range phone" the brief asked for.** Its numbers are
> an optimistic bound for Android, not a representative one. Chrome is within one patch of the
> desktop's, which does make the two columns genuinely comparable to each other.

Throwaway code lives on the `spike-wasm-core` branch under `spike/`. Nothing there is meant to
ship; it exists to answer three assumptions before anything is designed against them.

## Verdict

**All three assumptions hold, and the combo feed measured afterwards holds too. No kill criterion fires.** Two of the three were resting on
premises that have since gone out of date, and both moved in our favour.

| Assumption from the brief | Outcome |
| --- | --- |
| 1. `rusqlite` can reach the browser | **Yes, natively.** No shim to write. |
| 2. Cross-origin isolation is one coupled decision | **It is not a decision at all.** COI is not required. |
| 3. The ingest can run in wasm | **Yes.** 10.4 s desktop, 36.5 s phone. |
| (added) The 639 MB Spellbook feed | **Yes.** 12.6 s desktop, 23.1 s phone, 2.01 MB peak. |

Three findings force design rather than merely inform it, and they are in
[What this costs](#what-this-costs) below: **no WAL**, **one connection means one tab**, and
`navigator.storage.estimate()` **cannot be trusted as a pre-flight**.

## The corpus, measured

`SUM(pgsize) FROM dbstat` on a page-for-page copy of the live database
(`src-tauri/target/debug/data/mtg.db`, `user_version` 25, 116 843 printings, 38 626 distinct
`oracle_id`, 107 498 paper printings). **Total 751.0 MB**, not the 547 MB in
[data-and-sync.md](../../reference/data-and-sync.md) — that figure predates the art-tag ingest.

| Object | Bytes | Share |
| --- | --- | --- |
| `cards` | 489.3 MB | 65.2% |
| — of which the `raw` column | **224.7 MB** (avg 2 017 B/row) | 29.9% |
| art tagger — `art_tag_illustrations` 62.1, its slug index 46.3, `art_taggings` 30.4, `art_tags` 1.1, `art_tag_parents` 0.5 | **140.4 MB** | 18.7% |
| oracle tagger — `oracle_tag_cards` 26.7, its slug index 23.0, `oracle_taggings` 16.4, `oracle_tags` 0.6, `oracle_tag_parents` 0.2 | **66.9 MB** | 8.9% |
| `cards` indexes + autoindex | 34.7 MB | 4.6% |
| `cards_fts` (data 15.1, docsize 1.3, idx 0.1) | 16.5 MB | 2.2% |
| `image_cache` (metadata only; the files are a separate 519 MB over 7 929 entries) | 1.4 MB | 0.2% |
| **all user tables together** | **~0.1 MB** | 0.0% |

**Dropping `raw` leaves 526 MB.** That is Tier A and it is the target the spike was told to
prove. It is *not* the ~312 MB the brief's arithmetic implied, because the brief was subtracting
from the stale 547 MB.

Tier B — also skipping the art tagger — would be **386 MB**. The app already has a designed
"never fetched art tags" state, so Tier B is a supported configuration rather than new code.

> **The documented Tier C fallback breaks sync as written.** `collection_entries.card_id` and
> `deck_cards.card_id` are Scryfall *printing* UUIDs, and the collection's unique grain is
> eleven terms beginning with `card_id`. A one-printing-per-oracle corpus means an entry synced
> from desktop names a printing that device has no row for — it cannot render the name, art,
> price or legality. Repairable by fetching `/cards/:id` on demand and caching, but that repair
> is unbudgeted work rather than a simplification.

## Assumption 1 — `rusqlite` in the browser

**The premise is obsolete. `rusqlite 0.40` supports `wasm32-unknown-unknown` natively**, and the
app is already on 0.40. From its own manifest:

```toml
default = ["cache", "ffi-sqlite-wasm-rs"]
ffi-sqlite-wasm-rs = ["dep:sqlite-wasm-rs"]

[target.'cfg(all(target_family = "wasm", target_os = "unknown"))'.dependencies.sqlite-wasm-rs]
version = "0.5.1"
optional = true
```

`sqlite-wasm-rs` — the crate the brief asked me to evaluate as a hand-wired shim — is already
rusqlite's declared FFI backend for that target, in its **default** feature set. There is no
`links` override, no build-script override, no shim. A second supported route,
`wasm32-wasi-vfs`, exists as a feature for the WASI build the brief also asked about.

The whole manifest change for the web target:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
rusqlite = { version = "0.40", features = ["bundled", "hooks"] }

[target.'cfg(target_family = "wasm")'.dependencies]
rusqlite = { version = "0.40", features = ["hooks"] }
```

> ⚠️ **`default-features = false` is what breaks this**, and it fails in a misleading way. It
> switches `ffi-sqlite-wasm-rs` off, and rusqlite then fails to compile with
> `unresolved import libsqlite3_sys` — which reads exactly like "rusqlite does not support wasm"
> and is the opposite of the truth. This cost a build here.

### What Probe 1 asserted

All six steps PASS, in a browser, through rusqlite's own API:

```
PASS  link/sqlite3_threadsafe   returns 0
PASS  link/sqlite3_libversion   3.53.0
PASS  rusqlite/Connection::open opened
PASS  rusqlite/query_row        3.53.0
PASS  fts5/create+match         MATCH 'damage' returned 2 rows (expected 2)
PASS  rusqlite/update_hook      fired 3 times (insert, update, delete-with-WHERE)
PASS  pragma/compile_options    (below)
```

**Both predicted killers missed.** `sqlite3_threadsafe()` returns 0 — the amalgamation is built
`-DSQLITE_THREADSAFE=0` — and rusqlite opened anyway: its `Error::SqliteSingleThreadedMode`
guard sits on the `libsqlite3-sys` path, not the wasm one. And `-DSQLITE_OS_OTHER`
notwithstanding, `Connection::open` succeeded with no VFS registered, because `sqlite-wasm-rs`
installs its memory VFS as the default at init.

`PRAGMA compile_options`, read rather than recalled:

> `ATOMIC_INTRINSICS=1, COMPILER=clang-22.1.8, DEFAULT_AUTOVACUUM, DEFAULT_CACHE_SIZE=-16384,
> DEFAULT_FILE_FORMAT=4, DEFAULT_JOURNAL_SIZE_LIMIT=-1, DEFAULT_MMAP_SIZE=0,
> DEFAULT_PAGE_SIZE=8192, DEFAULT_PCACHE_INITSZ=20, DEFAULT_RECURSIVE_TRIGGERS,
> DEFAULT_SECTOR_SIZE=4096, DEFAULT_SYNCHRONOUS=2, DEFAULT_WAL_AUTOCHECKPOINT=1000,
> DEFAULT_WAL_SYNCHRONOUS=2, DEFAULT_WORKER_THREADS=0, DIRECT_OVERFLOW_READ, ENABLE_API_ARMOR,
> ENABLE_BYTECODE_VTAB, ENABLE_COLUMN_METADATA, ENABLE_DBPAGE_VTAB, ENABLE_DBSTAT_VTAB,
> **ENABLE_FTS5**, ENABLE_MATH_FUNCTIONS, ENABLE_OFFSET_SQL_FUNC, ENABLE_PREUPDATE_HOOK,
> ENABLE_RTREE, ENABLE_SESSION, ENABLE_STMTVTAB, ENABLE_UNKNOWN_SQL_FUNCTION,
> ENABLE_UNLOCK_NOTIFY, MALLOC_SOFT_LIMIT=1024, MAX_ATTACHED=10, MAX_COLUMN=2000,
> MAX_COMPOUND_SELECT=500, MAX_DEFAULT_PAGE_SIZE=8192, MAX_EXPR_DEPTH=1000,
> MAX_FUNCTION_ARG=1000, MAX_LENGTH=1000000000, MAX_LIKE_PATTERN_LENGTH=50000, MAX_MMAP_SIZE=0,
> MAX_PAGE_COUNT=0xfffffffe, MAX_PAGE_SIZE=65536, MAX_SQL_LENGTH=1000000000,
> MAX_TRIGGER_DEPTH=1000, MAX_VARIABLE_NUMBER=32766, MAX_VDBE_OP=250000000,
> MAX_WORKER_THREADS=0, MUTEX_OMIT, OMIT_DEPRECATED, OMIT_LOAD_EXTENSION, OMIT_SHARED_CACHE,
> SYSTEM_MALLOC, TEMP_STORE=2, THREADSAFE=0, USE_URI`

SQLite **3.53.0**. FTS5, DBSTAT, COLUMN_METADATA and PREUPDATE_HOOK all present.
`DEFAULT_PAGE_SIZE=8192` where the live database is 4096, so web page counts do not map 1:1
onto the `dbstat` table above.

The compiled artifact is **1.6 MB of wasm** before `wasm-opt` (2.2 MB once reqwest, flate2 and
serde join it in Probe 3). The app shell is not the download problem; the corpus is.

> **`update_hook` and the truncate optimization.** The hook first appeared to fire twice for
> three writes. It is not a wasm defect: `DELETE FROM t` with no `WHERE` takes SQLite's truncate
> optimization, which skips the update hook on every platform. With a `WHERE` it fires all
> three times. **This has a consequence for shipped desktop code** — `reset.rs` empties seven
> user tables with unqualified `DELETE FROM`, which is exactly that shape, so a reset may be
> invisible to the mirror's dirty map. Flagged, not investigated.

## Assumption 2 — cross-origin isolation

**It is not required, and the brief's "four things stand or fall together" collapses.**

`sqlite-wasm-vfs 0.2.0` offers three VFSes and the README marks all three "No COOP/COEP
requirements". That was tested rather than quoted: the identical page was served with and
without `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
and passed both ways.

| | install | write 532.8 MB |
| --- | --- | --- |
| No COOP/COEP | 65 ms | 3.3 s (162.1 MB/s) |
| With COOP/COEP | 50 ms | 2.3 s (233.7 MB/s) |

The difference is cache noise, not a real effect. **Consequences:**

- The PWA's service worker **does not have to re-attach isolation headers** on a navigation it
  serves from cache. The "works on first load, breaks on the second" failure the brief flagged
  is designed out rather than defended against.
- COI remains *available* if wasm threads ever earn their keep. It is a free choice now instead
  of a forced coupling.

## Assumption 3 — the ingest

**The largest unexamined risk was not in the brief at all**, and it had to be settled before
anything else mattered: decision 5 requires a browser to fetch Scryfall's bulk data directly.

```
api.scryfall.com/bulk-data/default_cards → access-control-allow-origin: *
data.scryfall.io/default-cards/*.jsonl.gz → Access-Control-Allow-Origin: *, honours Range
```

Both hosts allow it. Without that, "every platform builds its own corpus" would have been
impossible rather than merely hard.

### reqwest streams on wasm

The brief expected it not to. It does, as of **0.12.28** — `src/wasm/response.rs:137`:

```rust
#[cfg(feature = "stream")]
pub fn bytes_stream(self) -> impl futures_core::Stream<Item = crate::Result<Bytes>> {
    let body = wasm_streams::ReadableStream::from_raw(body.unchecked_into());
```

Gated on `feature = "stream"`, which **`src-tauri/Cargo.toml` already enables**. The 639 MB
Spellbook feed therefore never needs buffering, and the hand-rolled `web_sys` + `ReadableStream`
fallback the brief asked me to cost out is unnecessary. `src-tauri`'s verbatim reqwest line —
`default-features = false, features = ["rustls-tls", "stream"]` — compiles clean for wasm32,
including the `tokio/fs` that `stream` expands to, and so does `flate2` on its default
miniz_oxide backend.

### The measured run

Streaming throughout: `bytes_stream()` feeds a `flate2::write::GzDecoder` whose sink is drained
a line at a time, carrying the partial tail between chunks. Peak memory is one chunk plus one
batch — the same shape `src-tauri/src/ingest.rs` already has, differing only in that the desktop
reads a file it downloaded and this reads the socket.

| | Desktop | Android |
| --- | --- | --- |
| bulk descriptor | 1.1 s | 0.9 s |
| stream + parse + insert | 7.3 s | 27.3 s |
| — of which parse | 1.6 s | 5.8 s |
| — of which insert | 3.2 s | 8.6 s |
| — of which network + gunzip | 2.5 s | 12.9 s |
| 3 indexes | 0.9 s | 3.4 s |
| FTS5 rebuild | 1.0 s | 4.6 s |
| **total wall clock** | **10.4 s** | **36.5 s** |
| resulting database | 325.4 MB | 325.4 MB |

74.4 MB gzipped in, 598.8 MB of JSON out, **117 464 lines, 117 464 parsed, 0 skipped** on both
machines. Android is ~3.5× desktop, and most of that gap is network rather than CPU.

> **These numbers understate the real ingest, in three known ways.** The row written is a
> **20-column subset** of the real 43 — though the four JSON sub-objects that dominate parse
> time and row width (`legalities`, `prices`, `image_uris`, `card_faces`) are re-serialised and
> stored exactly as the real ingest stores them. `raw` is absent, by decision 6. And **none of
> the three optional feeds is ingested here**: oracle tags (5.85 MB), art tags (12.5 MB) and
> Spellbook combos (27.5 MB gz over 639 MB of JSON) are all still unmeasured in a browser.

For scale: the resulting 325.4 MB is close to the live `cards`-without-`raw` plus its indexes
plus FTS (264.6 + 34.7 + 16.5 = 315.8 MB). The remaining ~200 MB of Tier A is the two taggers.

### Queries after the ingest

Not comparable to the baseline table — the FTS here indexes three columns rather than the
shipped set, and `count(*)` over a `MATCH` is not the collapsed browse. Recorded as evidence
that FTS5 works and is not pathologically slow, nothing more.

| | Desktop | Android |
| --- | --- | --- |
| `count(*)` over 117 464 rows | 2.0 ms | 8.0 ms |
| FTS `dragon` (2 555 matches) | 3.0 ms | 17.0 ms |
| FTS `bolt` (157 matches) | 0.0 ms | 1.0 ms |

## Assumption 3b — the Spellbook combo feed

The largest parse in the app, and the only feed that is **not** line-delimited: one JSON object
whose `variants` key holds the whole array. `Access-Control-Allow-Origin: *`, honours ranges,
**27 555 788 bytes gzipped over 639 866 292 bytes (610.2 MB) of JSON**, matching the figures in
[commander-brackets.md](../../reference/commander-brackets.md).

| | Desktop | Android |
| --- | --- | --- |
| stream + parse + insert | 12.1 s | 22.0 s |
| — of which parse | 1.8 s | 5.5 s |
| — of which insert | 9.7 s | 12.6 s |
| — of which network + gunzip | 0.6 s | 3.9 s |
| index on `combo_cards(oracle_id)` | 0.4 s | 0.8 s |
| **total wall clock** | **12.6 s** | **23.1 s** |
| resulting database | 78.2 MB | 78.2 MB |
| **peak framing buffer** | **2.01 MB** | **2.01 MB** |

111 148 variants seen, 105 516 kept, 5 632 skipped by the OK/Commander rule, **0 unparsable**,
374 040 `combo_cards` rows — identical on both machines. **Both counts were cross-checked by an
independent scan of the same file in Node** (pattern counting rather than brace framing) and
agree exactly: 111 148 and 105 516.

Two port problems came out of this, and both are real work rather than harness detail.

### The desktop parser cannot be reused

`combos.rs` streams with `serde_json::Deserializer::from_reader` plus a `DeserializeSeed` over
the array. That is a **pull** parser: it calls `read()` when it wants more and blocks until it
gets it. A wasm stream is push and async, and there is no thread to block — so `from_reader`
cannot be driven from it at all.

The approach used here, and the one worth carrying forward: **frame the array elements by hand,
then parse each whole element with `serde_json::from_slice`.** Depth-count braces while tracking
string and escape state, so a `{` inside a card name does not desynchronise the file. Peak
memory is one element plus one batch — measured at **2.01 MB against a 610 MB document**. It
keeps serde for what serde is good at and replaces only the part that needed a blocking read.

> ⚠️ **The framer fails silently when it is wrong.** A first version did not reset its
> per-element state after the caller drained a completed prefix, so the rescan counted the same
> braces twice, depth never returned to zero, and no further element was ever emitted. The
> symptom was not an error: it found **63 elements in 610 MB** and grew its buffer to 609.82 MB.
> Any implementation of this needs the buffer size asserted, not just the row count.

### Who decompresses is not the same on both platforms

| Feed | `Content-Type` | `Content-Encoding` |
| --- | --- | --- |
| Scryfall `.jsonl.gz` | `application/gzip` | **none** |
| Spellbook `variants.json.gz` | `application/json` | **`gzip`** |

Spellbook sends `Content-Encoding: gzip` **even when the client asks for `identity`**. A
browser's `fetch` transparently decodes any such response and **there is no way to opt out**, so
`bytes_stream()` yields plain JSON and gunzipping it again fails with `invalid gzip header` —
which is how this was found. Desktop reqwest, without its `gzip` feature, does not decode, so
`combos.rs` gunzips explicitly and is correct.

The fix that is right on both: **sniff the two-byte gzip magic (`1f 8b`) off the first chunk**
and decide from the bytes rather than from a header, a feature flag or a file extension.

> **A note for the desktop.** The absent `gzip` feature is load-bearing for the combo feed, and
> for a different reason than `Cargo.toml` gives. That comment explains it in terms of Scryfall,
> which sends no `Content-Encoding` and would be unaffected either way. Spellbook does send one —
> so enabling that feature would break the combo ingest with exactly the error above, while
> leaving Scryfall's ingest working.

## Storage

`opfs-sahpool` in a dedicated Worker, growing a real SQLite file to Tier A's size, then
reopening it after the process that wrote it was gone.

| | Desktop | Android |
| --- | --- | --- |
| VFS install | 65 ms | 160 ms |
| write 532.8 MB | 3.3 s (162.1 MB/s) | 4.8 s (110.4 MB/s) |
| **second load** | full browser restart, same profile | tab navigated away and back |
| VFS reattach | 40 ms | 90 ms |
| file intact | 532.8 MB | 532.8 MB |
| `count(*)` — 335 000 rows | 16.0 ms | 46.0 ms |
| primary-key lookup | 1.00 ms | 2.00 ms |
| `count(DISTINCT)` full scan | 509 ms | 2 104 ms |

**Tier A stores, and survives.** 526 MB against a reported ~10.6 GB quota, and the desktop case
was verified the hard way: Chrome fully killed, relaunched on the same profile, database read
back byte-intact.

## What this costs

Three constraints that belong in the spec, not in a footnote.

**1. No WAL.** `PRAGMA journal_mode = WAL` answers `delete` on the sahpool VFS. The web target
runs a rollback journal. This changes durability semantics against desktop, not just speed.

**2. One connection means one *tab*.** The VFS table's "Multiple connections ❌" is sharper in
practice than it reads. A second document opening the same OPFS database does not queue — it
fails hard:

```
NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle':
Access Handles cannot be created if there is another open Access Handle or Writable stream
associated with the same file.
```

Two tabs of the web app is a hard failure today. `pause_vfs()` / `unpause_vfs()` exist, so a
handoff is buildable — but "what happens when the reader opens a second tab" is now a question
the design has to answer out loud. It also means the entire database lives in one Worker, so
every read and write in the app queues through it.

**3. `navigator.storage.estimate()` is not a pre-flight.** It reported 647 MB during the desktop
fill, then **7 MB** immediately after a restart, against a file that was 532.8 MB both times.
It also reported an identical 10 887.0 MB quota on the desktop and on the phone, which is itself
a reason to distrust it. Anything that asks "will the corpus fit" before starting must not ask
this.

**4. No app-identifying `User-Agent`.** It is a forbidden header for `fetch`, so the browser
sends its own. That is a real UA rather than an absent one — which is what Scryfall's rule is
about — but it is not the string the desktop sends, and the spec should say so.

## Toolchain this added

| Tool | Why | Note |
| --- | --- | --- |
| `rustup target add wasm32-unknown-unknown` | the target | |
| `wasm-bindgen-cli 0.2.127` | ES module + JS glue | must match the `wasm-bindgen` crate exactly |
| **LLVM / clang** (22.1.8 here) | `sqlite-wasm-rs` compiles SQLite's C amalgamation with `cc`, and MSVC cannot emit wasm | **becomes a permanent CI requirement if the web target ships** |
| `adb` (platform-tools 37.0.1) | `adb reverse` makes the dev server `localhost` on the phone, which is a secure context, so OPFS and service workers work with no HTTPS setup | **no Android SDK, NDK or Gradle needed for this** — those belong to the Tauri-mobile target, not to the browser |

`wasm-pack` was deliberately not used: it downloads its own toolchain at run time, and a spike
whose numbers depend on an opaque auto-download is not a spike whose numbers mean anything.

## Still unmeasured

Named so nothing here reads as more complete than it is.

- **The two tagger feeds in a browser.** Oracle tags (5.85 MB) and art tags (12.5 MB) are the
  same JSONL shape as `default_cards`, which is measured, and are 6× and 13× smaller — so the
  download and parse are low-risk by inference. What is *not* inferable is their index build:
  the art tagger is 140.4 MB of the corpus and is index-heavy, and index time was 0.9 s / 3.4 s
  for three indexes over 117 k card rows. Unmeasured, and labelled so.
- **The real query shapes.** `facets::compute` (1.8 ms) is pure Rust over in-memory bitsets and
  ports with no VFS involved, but the collapsed browse (131.8 ms end-to-end through IPC) rides
  SQLite and has not been run here against the real corpus and the real SQL.
- **The desktop baseline, re-measured on today's build.** The comparison table in the brief
  predates this work; both columns are owed in the implementation PR.
- **A mid-range Android phone.** Everything above is a flagship.
- **`navigator.storage.persist()` actually granted.** It reported `false` throughout, which is
  expected in headless Chrome with no install and no user gesture. The PWA durability story
  needs a real installed page to test.
