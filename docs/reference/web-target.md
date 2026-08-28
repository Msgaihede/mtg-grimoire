# The web target

The browser build: the same Rust core compiled to `wasm32-unknown-unknown`, running inside one
dedicated Worker with its two SQLite files in OPFS, talking to the same React frontend through
the `Core` interface Phase 1 shipped.

Every figure below was taken on **2026-08-28**, on Windows 11, in **headless Edge 151** against
`npm run web:dev` on port 5173, driven over CDP (9333 for the first pass, 9444 for the
2026-08-28 re-measurement of the first run and the one-tab guard). The wasm is a **release** build
(`cargo build --release --target wasm32-unknown-unknown`) with no `wasm-opt` pass. Where a
figure from [the spike](../superpowers/research/2026-08-27-wasm-core-spike.md) is comparable it
sits beside it, **with the caveat that the spike wrote a 20-column synthetic row and this writes
the real 43-column one, `raw` included**.

> ## The first run finished 6 of 6, and what used to break it
>
> **Until 2026-08-28 roughly two runs in three died partway through the corpus ingest** with a
> panic in wasm's allocator, and the page sat on a frozen card count forever. The cause is
> now known, fixed, and was never what the message said.
>
> The Worker's console read:
>
> ```text
> panicked at /rust/deps/dlmalloc-0.2.11/src/dlmalloc.rs:1201:9:
> assertion failed: psize >= size + min_overhead
> ```
>
> **That is not an out-of-memory.** Line 1201 is `Dlmalloc::validate_size`, which every
> `dealloc` and every `realloc` runs: it compares the size the caller *claims* the block had
> against the size in the chunk's own header. Failing it means a free of something that was
> never allocated that way — heap corruption. Linear memory when it fired was **171.6 MB and
> flat**, sampled every 500 ms off `WebAssembly.Memory.buffer.byteLength`; nothing was running
> out of anything. The `RefCell already borrowed` in `js-sys/src/futures/queue.rs` that follows
> is the panic hook running inside a queue whose borrow the first abort never released — it is
> the second error, never the first.
>
> **The corruption was two wasm instances in one Worker.** `src/workers/db.ts`'s `load()` had
> no in-flight guard: `if (!glue) { … await import … await mod.default() … glue = mod }` sets
> the variable it tests only at the end, so two `postMessage`s that land in the same turn both
> find it unset and both run. `wasm-bindgen`'s own re-entry guard has the identical shape —
> `if (wasm !== undefined) return wasm`, read synchronously, with `wasm` assigned only after
> the instantiate resolves — so both calls also sail past that and **both instantiate the
> module**. Measured in the Worker: `distinctMemories=2`. The glue then holds one `wasm`
> binding, pointing at the second instance, while every callback the first one registered —
> each `JsFuture`'s `then`, every `Closure` — is still dispatched through it, carrying pointers
> into a linear memory that is no longer the one being indexed. What sent the two messages is
> `<React.StrictMode>`, which invokes `WebBoot`'s effect twice; any two calls arriving before
> the module finished loading would do it.
>
> The visible sequence, in order, on a failing run: `Error: closure invoked recursively or
> after being dropped` about 40 ms after the second instance lands, then the `dealloc` panic
> anywhere between 46 000 and 116 000 rows later, then `unreachable`, then a
> `memory access out of bounds` inside `CLOSURE_DTORS`.
>
> **The fix is `once()` in `src/workers/db.ts`** — memoise the promise, not the result.
> Measured after it, on the same harness: **6 clean runs from a wiped browser profile, 6
> completed**, 117 606 rows each, one `WebAssembly.Memory` per Worker each time.
>
> It also fixed the one-tab guard, which had the same single cause. See below.

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
| Wall clock, click to app rendered | **15.6 s to 16.3 s** across six clean runs, sampled every 500 ms | spike: 10.4 s desktop, 36.5 s phone |
| Ingest rate, sampled at 250 ms | 0 → **88 000 rows in 10.8 s**, ~8 100 rows/s | — |
| Runs that finished | **6 of 6** clean runs from a wiped profile (was 2 of 6) | spike: always |
| wasm module | **2 642 182 B** (`mtg_grimoire_lib_bg.wasm`) | spike: ~2.2 MB |
| wasm-bindgen glue | 42 562 B | — |
| `navigator.storage.estimate()` after a *partial* ingest | usage **447 MB**, quota **10 687 MB** | — |
| Linear memory at peak, whole first run | **148.6 MB** to **171.6 MB** | — |
| Journal, both files | `delete` | desktop: `wal` |

The wall clock is a range across six runs rather than one number: it is dominated by the
75 MB download from Scryfall, and the poll that decides "app rendered" runs every 500 ms, so
each figure carries that much slack. Six runs of the same fix an hour earlier read 15.2–16.1 s,
which is the size of the noise. It replaces the 11–21 s this table used to quote, which was
taken across the flaky path and was not a figure.

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
3. **A second tab is refused**, with a sentence rather than a stack trace. See below.
4. **The `User-Agent` is the browser's.** It is a forbidden header for `fetch`, so this build is
   not identified to Scryfall the way the desktop is. That is a real UA rather than an absent
   one, which is what Scryfall's rule is about, but it is not ours — and the desktop's
   rate-limit pacing and 429 penalty do not exist here at all. Both are owed with the sync port.

## The one-tab guard fires, and the premise was never the problem

Spec §5.2 settled that the first tab wins and the second gets a sentence. It does, since
2026-08-28. `wire::Opened::from_open_error` and `AlreadyOpen.tsx` were correct all along —
what was missing was the refusal ever reaching them, and the cause was the *same single bug*
as the memory failure above.

**`opfs-sahpool` does refuse a second document, and that is measured rather than assumed.**
With one tab open on an installed pool, a throwaway Worker in that same page that walks
`mtg-grimoire/.opaque` and calls `createSyncAccessHandle()` on every entry gets
**0 of 64 locked, 64 of 64 refused**, each with

```text
NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on
'FileSystemFileHandle': Access Handles cannot be created if there is another open Access
Handle or Writable stream associated with the same file.
```

Exclusivity is global rather than per-document, which is why a probe in the *first* tab can
count what that tab is holding.

**What the second tab was really doing before the fix, and it was worse than sharing.** Its
Worker also ran two wasm instances. The browser refused the pool exactly as it was supposed
to, but the refused instance's `async fn` was being resumed through the *other* instance's
linear memory, so `install_opfs_pool` came back `Ok` from a call the browser had denied.
`db::open_pooled_pair` then opened `user.db` on whatever VFS was still the default — which is
`rsqlite_vfs::memvfs`, installed by `sqlite3_os_init` — and the page got a private in-memory
database while reporting `dataDir: "OPFS:/mtg-grimoire"`, a string the Rust side formats from
its argument and which proves nothing about the medium.

The measurement that settles it: tab 1 ingests the full corpus, then tab 2 opens.

| | Before (2249a50) | After |
| --- | --- | --- |
| tab 1 `sync_status.cardCount` | 117 606 | 117 606 |
| tab 2's page | the first-run "Build the card database" screen | **"MTG Grimoire is already open"** |
| tab 2 `sync_status` | `cardCount: 0`, `dataDir: OPFS:/mtg-grimoire` | `Error: the database is not open yet` |
| files in `.opaque` | 64 | 64 |

Sixty-four files throughout, with tab 1 holding every one of them: tab 2's database was never
in the pool, because a second pool would have had to preallocate sixty-four more. The two tabs
were not sharing one database — the second had silently been given a different, empty one.

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
- **A fix that moves a failure's threshold has not necessarily touched its cause.**
  `db::OPFS_TEMP_STORE` (sending SQLite's sort trees to the VFS instead of to memory) and
  raising `OPFS_INITIAL_CAPACITY` from 12 to 64 were both introduced against the ingest's
  `dlmalloc` death, and each turned a guaranteed failure into an intermittent one — which read
  as progress. It was not: the fault was a corrupted heap, and both changes only altered *where
  the allocations land*, so a bogus pointer hit a different chunk. The tell was the pattern
  itself. Both are still in the code and neither has been re-measured since the real cause was
  fixed; see "What is owed".
- **A wasm-bindgen module can be instantiated twice and nothing says so.** `__wbg_init`'s guard
  is `if (wasm !== undefined) return wasm`, and `wasm` is set after the `await`. Two overlapping
  callers get two instances, one shared `wasm` binding, and cross-instance pointers. The cheap
  detector, with no source change to the module: `Runtime.queryObjects` over
  `WebAssembly.Memory.prototype` in the Worker's session — one page, one Worker, one memory, or
  something is wrong.
- **A dropped `#[wasm_bindgen]` attribute compiles clean, with no error and no warning**, because
  the function stays `pub` in a `pub mod`. Only loading the module in a browser can catch it —
  so `scripts/build-wasm.mjs` greps the generated glue for all five entry points instead.

## What is owed

- **Whether `OPFS_TEMP_STORE` and an `OPFS_INITIAL_CAPACITY` of 64 are still needed.** Both
  were added against the failure at the top of this page, and both moved its threshold — which
  is what a change to the allocation *layout* does to a corrupted heap, and is not evidence
  that either was the cure. Neither has been re-measured against a build with one wasm
  instance, and neither was changed back: running the pool out of file slots mid-ingest is not
  survivable, so that experiment is worth doing deliberately rather than by leaving it in.
- **`@tauri-apps/api/window` throws in the browser.** Once the app renders, the page logs
  `TypeError: Cannot read properties of undefined (reading 'metadata')` from `getCurrentWindow`
  and `transformCallback` — the shell reaches for Tauri's window API on a target that has none.
  It does not stop anything rendering. Not investigated; it belongs with whatever ports the
  title bar.
- **A desktop baseline re-measurement.** Spec §8 requires one from any PR touching search,
  faceting or sync, and this one refactored the ingest (`ingest::StreamIngest`) and the index
  build (`index::lifecycle::build_from`). It was **not** taken: this worktree is a fresh install
  with no corpus, and driving the real window needs the app lock while two other agents are
  working. The 1 498-test Rust suite covers the refactors' behaviour — `ingest_stream` and
  `read_stream` keep every test they had — but the *timing* table in
  [data-and-sync.md](data-and-sync.md) is still owed a column.
- **A run on a phone.** Every figure here is desktop Edge. The spike's phone column suggests
  roughly 3.5× slower, and the memory ceiling is lower there.
