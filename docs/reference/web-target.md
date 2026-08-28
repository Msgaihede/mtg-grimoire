# The web target

The browser build: the same Rust core compiled to `wasm32-unknown-unknown`, running inside one
dedicated Worker with its two SQLite files in OPFS, talking to the same React frontend through
the `Core` interface Phase 1 shipped.

Every figure below was taken on **2026-08-28**, on Windows 11, in **headless Edge 151** against
`npm run web:dev` on port 5173, driven over CDP on 9333. The wasm is a **release** build
(`cargo build --release --target wasm32-unknown-unknown`) with no `wasm-opt` pass. Where a
figure from [the spike](../superpowers/research/2026-08-27-wasm-core-spike.md) is comparable it
sits beside it, **with the caveat that the spike wrote a 20-column synthetic row and this writes
the real 43-column one, `raw` included**.

> ## ⚠️ Read this first: the first run does not reliably finish
>
> **Roughly two runs in three, the corpus ingest dies partway through with an out-of-memory
> panic in wasm's allocator** and the page sits on a frozen card count forever. Measured over
> three clean runs from a wiped browser profile: **one completed** (117 606 cards, app
> rendered), the other two stalled at **110 000** and **116 000** rows. Two earlier runs under
> the same build stalled at 88 000 and completed once more, so the observed rate is about 2 of 6.
>
> The Worker console says:
>
> ```text
> panicked at /rust/deps/dlmalloc-0.2.11/src/dlmalloc.rs:1201:9
> Uncaught RuntimeError: memory access out of bounds
> ```
>
> `dlmalloc` is what `wasm32-unknown-unknown` allocates through, and a panic there is linear
> memory failing to grow. The `RefCell already borrowed` panic that follows it in
> `js-sys/src/futures/queue.rs` is the panic hook running inside a broken state — it is the
> second error, never the first.
>
> **Everything downstream of a completed ingest is correct and fast** — see the query table.
> The corpus is right (117 606 rows), the facet index builds, and all four routed commands
> answer. The failure is confined to building the corpus in the first place, and it takes the
> Worker with it: the page cannot even show an error, because the trap kills the instance
> before `handle`'s `catch` can post one.
>
> **This is open and unfixed.** It is the one thing standing between this build and a usable
> web target, and it is the first thing to pick up.

---

## What the web target is

- **One Worker, and that is where the app lives.** `opfs-sahpool` can only obtain its
  exclusive `FileSystemSyncAccessHandle`s off the main thread, so the VFS can only be installed
  in a Worker — and therefore so can the database. Every read and every write in the web build
  queues through `src/workers/db.ts`.
- **Two files, as on desktop.** `user.db` is `main` and `corpus.db` is `ATTACH`ed as `corpus`,
  exactly as `db::open_write` does with paths. `db::open_pooled_pair` is that function with
  bare names, because the pool *is* the filesystem.
- **A rollback journal, not WAL.** `PRAGMA journal_mode = WAL` answers `delete` on the pool —
  **on both files**, checked separately. `db::apply_pragmas` returns the journal SQLite
  actually chose rather than assuming one, which also makes a desktop that silently fell off
  WAL visible for the first time.
- **No COOP/COEP.** The spike served the same page with and without
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` and
  it passed both ways. **Do not add those headers**, and do not let a future service worker
  re-attach them.
- **Four commands**, not 136: `sync_status`, `search_cards`, `list_sets`, `facet_cards`. That
  is the browse, which is the read path spec §8 wanted measured in wasm rather than guessed.
  Adding a fifth once its module is in the map is one line in `web::route::COMMANDS` and one
  `match` arm.

## The module map

`src-tauri/src/lib.rs` is the map and the split in it is binding.

| Compiled for wasm | Desktop/Android only |
| --- | --- |
| `card_row` · `collection_source` · `combos` · `db` · `errors` · `feed` · `filters` · `index` · `ingest` · `legalities` · `maintenance` · `schema` · `search` · `slug` · `sorting` · `split` · `sync` · `web` | `card` · `collection` · `collection_alloc` · `collection_folders` · `deck` · `deck_audit` · `deck_meta` · `deck_theory` · `deck_undo` · `export` · `flatten` · `images` · `import` · `listview` · `marketplace` · `marketplace_feed` · `mirror` · `nav` · `paths` · `picked` · `reconcile` · `reset` · `scryfall` · `tags` · `transfer` · `update` · `window` · `wishlist` · `wishlist_folders` · `zoom` |

**Four of the exclusions are permanent** (spec §6.3): the plain-text `mirror`, the Rust
`transfer` writer that exists only for it, the portable `update` swap, and `window`'s Win32
snap layouts. The rest are "not yet" — they arrive with the commands that need them. `images`
is neither: on web the image cache is Cache Storage rather than a filesystem, so it is a
rewrite and not a port.

`split` is the odd one in the left column. It compiles there and can never succeed —
every path in it is `std::fs`, which builds for wasm and answers `Unsupported` — and gating it
would cost more than it buys, which is the same trade `combos::ingest_gz` already makes.

## Measurements

### The first run

| Figure | Value | Desktop / spike |
| --- | --- | --- |
| Rows ingested (completed run) | **117 606** | spike: 117 464 lines, 20-column subset |
| Wall clock, click to app rendered | **between 11 s and 21 s** on the one run sampled that finely | spike: 10.4 s desktop, 36.5 s phone |
| Ingest rate, sampled at 250 ms | 0 → **88 000 rows in 10.8 s**, ~8 100 rows/s | — |
| Runs that finished | **1 of 3** clean runs (2 of 6 including earlier builds) | spike: always |
| wasm module | **2 642 182 B** (`mtg_grimoire_lib_bg.wasm`) | spike: ~2.2 MB |
| wasm-bindgen glue | 42 562 B | — |
| `navigator.storage.estimate()` after a *partial* ingest | usage **447 MB**, quota **10 687 MB** | — |
| Journal, both files | `delete` | desktop: `wal` |

The wall clock is a range and not a number because the run that finished was sampled only every
10 s at that point; the one run sampled at 250 ms stalled. **Re-measure this properly once the
memory failure is fixed** — a first-run figure taken across a flaky path is not a figure.

**`navigator.storage.estimate()` is never consulted by the app and must not be.** The spike saw
it report 647 MB and then 7 MB for the same 532.8 MB file. It may be *reported*; it is not a
pre-flight.

### The two query shapes spec §8 asked for

Five samples each, against the full 117 606-row corpus, through `core.call` from the page — so
these include the `postMessage` round trip, not just SQLite.

| Query | Cold | Median | Worst | Desktop today |
| --- | --- | --- | --- | --- |
| `search_cards` collapsed browse, no filters | 134 ms | **53 ms** | 134 ms | 131.8 ms end-to-end |
| `search_cards` `text: "dragon"` (2 475 matches) | 448 ms | **67 ms** | 448 ms | — |
| `facet_cards` unfiltered | 8 ms | **5 ms** | 8 ms | 1.8 ms |
| `facet_cards` `text: "dragon"` | 3 ms | **3 ms** | 4 ms | — |

**Both are inside spec §8's 250 ms p95 budget**, and the collapsed browse is *faster* in the
browser than the 131.8 ms the desktop measures end-to-end today. The first call of each shape
pays a cold page cache — 134 ms and 448 ms — and that is the number a reader actually meets
once per session.

**`facets::compute` ported as ordinary Rust, exactly as spec §8 predicted.** It reads an
in-memory structure of bitsets and ordinal arrays and never touches SQLite, and 5 ms against
desktop's 1.8 ms is the same order of magnitude. That prediction being right is worth as much
as it being wrong would have been.

## The four differences from desktop a reader could notice

1. **No WAL.** Both files run a rollback journal, so durability differs. `db::Journal` is what
   makes that a value the app can read rather than an assumption.
2. **One connection, so a search really does queue.** `AppState.db_read` is `cfg`'d away —
   **not** because the pool refuses a second connection, which was the spike's reading and is
   wrong. Measured 2026-08-28: a second `Connection::open` on an installed pool opens,
   attaches, reads and writes perfectly well. It is gone because a Worker is *one thread*, so a
   second connection could never be used concurrently, and under the rollback journal it would
   contend at the file level rather than sail past on a WAL snapshot.
3. **A second tab is supposed to be refused — and currently is not.** See below.
4. **The `User-Agent` is the browser's.** It is a forbidden header for `fetch`, so this build is
   not identified to Scryfall the way the desktop is. That is a real UA rather than an absent
   one, which is what Scryfall's rule is about, but it is not ours — and the desktop's
   rate-limit pacing and 429 penalty do not exist here at all. Both are owed with the sync port.

## ⚠️ The one-tab guard does not fire

Spec §5.2 settled that the first tab wins and the second gets a sentence. `wire::Opened::from_open_error`
classifies the browser's refusal correctly and is unit-tested against the real message. **What is
not true is the premise: a second document is not reliably refused.**

Measured 2026-08-28, two tabs of `http://localhost:5173/` driven individually by CDP target id
(the two share a URL, so `scripts/cdp.mjs` — which takes the first `type: page` — cannot tell
them apart):

- **Both tabs rendered the first-run page**, neither showed `AlreadyOpen`.
- **Both answered `sync_status`** with `dataDir: "OPFS:/mtg-grimoire"`, so both had a live
  database on the same pool.
- Tried at `OPFS_INITIAL_CAPACITY` of **64 and of 12** — no difference, so the pool's file
  count is not the variable.

Probe 6 saw the opposite on the same machine an hour earlier: a second document there failed at
`install_opfs_pool` with

```text
CreateSyncAccessHandle(JsValue(NoModificationAllowedError: Failed to execute
'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there
is another open Access Handle or Writable stream associated with the same file.))
```

The difference between the two has **not** been isolated. The probe's first tab had written
tables and rows before the second opened; the app's had an empty database. Until this is
understood, **two tabs can share one database**, which is precisely the failure §5.2 wanted
designed out. `AlreadyOpen.tsx` and its tests are correct and ready; what is missing is the
refusal that is supposed to trigger them.

## What is not built yet

- **The other 132 commands**, and the modules in the right-hand column above.
- **The image cache.** On web it is Cache Storage, which is a rewrite rather than a port.
- **The price feeds**, and **Mana Pool is unavailable on web at all** (spec §5.3): it sends no
  `Access-Control-Allow-Origin`. Card Kingdom does.
- **`ingest_combos` is written and exported but has never been run.** Reaching it needs a
  `ToWorker` case the app does not have, and adding one only to measure would have been
  scaffolding rather than a path the app has. Not measured, deliberately.
- **The PWA shell** — manifest, service worker, update bar, evicted-corpus recovery. PR 5.
- **Sync, pairing, the relay.** Phase 3.
- **Mobile layout.** Phase 5.

## The toolchain

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127 --locked   # must match the crate EXACTLY
# clang must be on PATH; on Windows that is LLVM's, e.g. C:\Program Files\LLVM\bin
```

- **clang is a permanent build requirement.** `sqlite-wasm-rs` compiles SQLite's C amalgamation
  with `cc` targeting wasm32, and MSVC cannot emit wasm. 22.1.8 is what these figures were taken
  on.
- **`wasm-bindgen-cli` must match the `wasm-bindgen` crate exactly.** A mismatch is not a build
  error — it fails at run time inside the generated glue, complaining about an import nobody
  wrote. The version is pinned with `=` in `Cargo.toml`, pinned again in
  `scripts/build-wasm.mjs`, and the script refuses to run when the two disagree.

Three npm scripts: `npm run build:wasm`, `npm run web:dev` (port 5173), `npm run web:build`
(into `dist-web/`). `web/public/` and `dist-web/` are both gitignored **in full** — everything
in them is generated, favicon copy included, which is what keeps a 2.5 MB wasm module out of the
desktop bundle and therefore out of the portable exe. Verified: `npm run build` leaves no
`.wasm` anywhere in `dist/`.

## Traps this build paid for, so the next one does not

- **`import("/wasm/…")` does not work in the Vite dev server, and `@vite-ignore` does not save
  it.** Vite rewrites every dynamic import whose specifier it cannot read statically into
  `__vite__injectQuery(spec, 'import')`, which appends `?import` — and Vite then refuses,
  because importing an asset out of `publicDir` from JavaScript is not allowed. The page read
  *"The card database would not open — TypeError: Failed to fetch dynamically imported module:
  http://localhost:5173/wasm/mtg_grimoire_lib.js?import"*. `injectQuery` opens with
  `if (url[0] !== "." && url[0] !== "/") return url`, so **an origin-absolute URL takes the
  early return** and the query is never appended. `src/workers/db.ts` builds one with
  `new URL(path, self.location.origin).href`. It must also stay a *variable*, because `tsc`
  resolves a literal specifier even inside `import()` and would fail the **desktop** build on a
  path only the web build reaches.
- **Vite's dev server serves a stale transform after an edit to a Worker module.** Twice the
  page kept reporting a bug that was already fixed on disk. `fetch()` the module URL and grep
  the served text before believing any live reading.
- **`schema::migrate_user` had nothing to create, and on web that was the bug.** Every desktop
  user file reaches it at version 27, because `split::convert` makes one — and even a fresh
  install goes the long way round, building a legacy `mtg.db` at 26 and splitting it. A browser
  has no `mtg.db`. Before this was fixed the web build opened a pair whose corpus had a shape
  and whose user half had **no tables at all**, and the only thing that noticed was the facet
  index: `index build: no such table: collection_entries`, in a Worker console, with the page
  otherwise working.
- **`temp_store` defaults to memory on wasm**, and the staging swap's index replay and FTS
  rebuild build their sort trees there. `db::OPFS_TEMP_STORE` sends them to the VFS instead;
  without it the ingest died in `dlmalloc` at 116 000 rows every time. It is a mitigation and
  not a cure — see the warning at the top.
- **`OPFS_INITIAL_CAPACITY` is 64 because 12 was not enough.** The pool preallocates *files*,
  and this app wants two databases, two rollback journals, a staging table, an index replay, an
  FTS rebuild and every temp b-tree behind them. At 12 the first run died 16 s in with
  `memory access out of bounds` before a single 2 000-row batch had reported.
- **A dropped `#[wasm_bindgen]` attribute compiles clean, with no error and no warning**, because
  the function stays `pub` in a `pub mod`. Only loading the module in a browser can catch it —
  so `scripts/build-wasm.mjs` greps the generated glue for all five entry points instead.

## What is owed

- **The memory failure above.** Nothing else matters until the first run is reliable.
- **The one-tab guard's premise.**
- **A desktop baseline re-measurement.** Spec §8 requires one from any PR touching search,
  faceting or sync, and this one refactored the ingest (`ingest::StreamIngest`) and the index
  build (`index::lifecycle::build_from`). It was **not** taken: this worktree is a fresh install
  with no corpus, and driving the real window needs the app lock while two other agents are
  working. The 1 498-test Rust suite covers the refactors' behaviour — `ingest_stream` and
  `read_stream` keep every test they had — but the *timing* table in
  [data-and-sync.md](data-and-sync.md) is still owed a column.
- **A run on a phone.** Every figure here is desktop Edge. The spike's phone column suggests
  roughly 3.5× slower, and the memory ceiling is lower there.
