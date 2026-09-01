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
- **120 commands of 155**, re-derived 2026-08-31 with `node scripts/routed-census.mjs` and
  correct only for as long as nobody adds one; the script is the answer, this line is a
  reminder that there is one. (It read **115 of 156** until that re-derivation, which was two
  numbers written by hand beside a script that prints both.) The first four are the browse —
  `sync_status`, `search_cards`, `list_sets`, `facet_cards` — which is the read path spec §8
  wanted measured in wasm rather than guessed. The rest are the Decks destination (PR 10b's
  thirteen reads and 10c's thirty-three writes), the Collection (10d's seventeen), the
  Wishlist (10e's fourteen), the card pane (10f's six), the Tagger (10g's ten of twelve),
  Settings (10h's fourteen) and the backup archive (`mirror_backup_zip`, 2026-08-31 — the
  crate gained two that day and one of them is routed). Adding one, once its module is in the
  map, is a line in `web::route::COMMANDS` and a `match` arm. **What the remaining 35 are, and
  why none of them is an oversight, is tabulated at the foot of this file** — grouped by file,
  exactly as the script prints them.

  `route.rs`'s `every_advertised_command_is_actually_routed` pins the routed number and is the
  reason it cannot rot; the crate total is prose and has drifted before, so re-count it in the
  same commit that changes it.

  ⚠️ **This is not the intended end state.** Decided 2026-08-29, after the phone layout made
  the boundary visible: **all of them but ten**, by destination, worst broken first. The survey,
  the ones that stay desktop-only and the reason each is a different feature rather than a port
  are at the foot of this file. **That ten is eight since 2026-08-31**: two of the five updater
  commands report rather than replace, and both are routed.

## The module map

`src-tauri/src/lib.rs` is the map and the split in it is binding.

| Compiled for wasm | Desktop/Android only |
| --- | --- |
| `app_meta` · `card` · `card_row` · `collection` · `collection_alloc` · `collection_folders` · `collection_source` · `combos` · `db` · `deck` · `deck_audit` · `deck_meta` · `deck_theory` · `deck_undo` · `errors` · `feed` · `filters` · `flatten` · `listview` · `image_uri` · `index` · `ingest` · `legalities` · `maintenance` · `marketplace` · `reset` · `schema` · `search` · `slug` · `nav` · `sorting` · `split` · `sync` · `sync_engine` · `sync_pair` · `tags` · `transfer` · `update` · `web` · `wishlist` · `wishlist_folders` · `zoom` · **`mirror`** — `layout`, `paths`, `read`, `readme`, `snapshot` | `export` · `images` · `import` · `marketplace_feed` · **`mirror`** — `run`, `settings`, `watch` · `paths` · `picked` · `reconcile` · `scryfall` · `window` |

**Nineteen modules have moved left**: eleven on 2026-08-29 (PR 10a) — the deck domain, the
collection, the wishlist, both folder tables and `marketplace` — then `card` (PR 10f) and
`tags` (PR 10g), and the four view-state modules `flatten`, `listview`, `nav` and `zoom`
(PR 10h), all on 2026-08-30; then `reset` and `update` on 2026-08-31. **Nothing in the first
twelve changed**: they were on the right because each file *ends* in a block of
`#[tauri::command]` wrappers, and the gate sat on the module instead of on the wrappers.
**`tags` was the exception and the first real split** — its ingest half is gated item by item
inside an otherwise portable module, because that half downloads. **`update` is the second
and the largest**: about two thirds of that file is gated where it stands. See the PR 10a,
10g and the 2026-08-31 sections at the foot of this file.

**One module is permanently excluded whole** — `window`'s Win32 snap layouts. Everything else
on the right is either "not yet" or **half of a module whose other half already crossed**, and
after 2026-08-31 that second case is the interesting one:

* **`update` is split by what it does.** §6.3 named "the portable `update` swap", and the swap
  is exactly what stayed: the `.exe` replacement, the staging, the digest check and the
  relaunch, along with `Updater` itself — its `reqwest` client sets `user_agent`,
  `connect_timeout` and `read_timeout`, none of which the wasm backend has. What crossed is the
  half that *reports*: `UpdateStatus`, `update::history` and the version comparison under them
  are a `serde` struct and two `app_meta` reads.
* **`mirror` is split by where its output goes.** The folder — `run`, `settings`, `watch` — is
  desktop's, because OPFS and an Android private directory are invisible to the programs a
  mirror exists for. The renderer is not, so web and Android get the same files as one archive.
* **`transfer` crossed whole**, which follows from the above: it is pure formatting with no
  filesystem and no clock, and it is the second implementation the golden fence exists for.

`images` is none of these: on web the image cache is Cache Storage rather than a filesystem, so
it is a rewrite and not a port.

**`mirror` and `transfer` were two of that permanent four until 2026-08-31**, and `mirror` is the
one module in the table on both sides. What made the folder impossible here — OPFS is invisible to
every other program, so a mirror in it would be the feature's name without the feature — says
nothing about the *renderer*, which never touched a filesystem. So the gate moved off the module
and onto `run`, `settings` and `watch`; `transfer` came with the rest, unchanged and still fenced
by `src/features/transfer/__golden__/`. What the browser does with it is
`mirror_backup_zip` — the same files, rendered on demand and handed over as one archive. Full
record in [text-mirror.md](text-mirror.md#web-and-android-the-same-files-as-one-archive).

**A module's column is a fact about its contents; being *routed* is a separate question.**
Everything on the left compiles for the target. What the browser can actually call is
`web::route::COMMANDS`, which is **120 of 155** — `node scripts/routed-census.mjs`, re-derived
2026-08-31. (This sentence said 115 of 156, the same hand-written pair *What the web target is*
carried; two copies of a number a script prints is two chances to be wrong, and both were.)

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
  `Access-Control-Allow-Origin`. Card Kingdom does. *(PR 11 built the path; the CORS finding
  stands, so Mana Pool's export is expected to fail in a browser.)*
- **`ingest_combos` is written and exported but has never been run.** Reaching it needs a
  `ToWorker` case the app does not have, and adding one only to measure would have been
  scaffolding rather than a path the app has. Not measured, deliberately. *(PR 11 added the
  `ToWorker` case. It still has not been run in a browser.)*
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
  so `scripts/build-wasm.mjs` greps the generated glue for every entry point the Worker
  imports instead. **That list is `EXPORTS` in the script and has to grow with the surface** —
  it stood at five until PR 11 added `ingest_tags` and `ingest_prices`, and an export missing
  from it is exactly the failure the gate exists for, unguarded.

## What is owed

- **Whether `OPFS_TEMP_STORE` and an `OPFS_INITIAL_CAPACITY` of 64 are still needed.** Both
  were added against the failure at the top of this page, and both moved its threshold — which
  is what a change to the allocation *layout* does to a corrupted heap, and is not evidence
  that either was the cure. Neither has been re-measured against a build with one wasm
  instance, and neither was changed back: running the pool out of file slots mid-ingest is not
  survivable, so that experiment is worth doing deliberately rather than by leaving it in.
- ~~**`@tauri-apps/api/window` throws in the browser.**~~ **Fixed 2026-08-29, and the cause was
  one word in a gate.** The page logged `TypeError: Cannot read properties of undefined (reading
  'metadata')` from `getCurrentWindow` and `transformCallback` on every load, and it did not stop
  anything rendering — which is why it read as noise.

  `AppShell` drew the caption unless `isAndroid()`, and that is false in a desktop browser. But
  **parity §5 gives the window's edge to the browser exactly as it gives it to the OS on
  Android**, so the reasoning the Android branch already carried transferred whole and nobody had
  transferred it. `src/lib/window.ts` imports `getCurrentWindow` at **module scope**, so mounting
  `TitleBar` at all was enough to throw — the buttons never had to be pressed.

  The gate is now `!isAndroid() && !isWebTarget()`. `isWebTarget()` rather than a second
  user-agent probe: the target is a build-time fact (`__CORE__`), so the branch folds away and
  the desktop bundle carries no web check at all. The two questions are genuinely different —
  *which platform is this agent* versus *which core was this built against*.

  **Driven in the production web build after the fix: zero console errors, zero caption buttons
  in the document, and the app renders.** `AppShell.test.tsx` pins both directions — no caption
  on the web build, and the caption still present on the desktop one, because a gate that
  answered "no caption" everywhere would pass the first and take the window's controls away from
  the only platform that needs them.
- **A desktop baseline re-measurement.** Spec §8 requires one from any PR touching search,
  faceting or sync, and this one refactored the ingest (`ingest::StreamIngest`) and the index
  build (`index::lifecycle::build_from`). It was **not** taken: this worktree is a fresh install
  with no corpus, and driving the real window needs the app lock while two other agents are
  working. The 1 498-test Rust suite covers the refactors' behaviour — `ingest_stream` and
  `read_stream` keep every test they had — but the *timing* table in
  [data-and-sync.md](data-and-sync.md) is still owed a column.
- **A run on a phone.** Every figure here is desktop Edge. The spike's phone column suggests
  roughly 3.5× slower, and the memory ceiling is lower there.

---

## One of six destinations works, and the phone layout is what made that visible

**Surveyed on the device 2026-08-29** — OnePlus, Chrome 152, portrait, against the production build
of `main` at PR #301 with a 117 606-card corpus. Each nav destination was opened in turn and its
`main` scraped for `unknown command`.

| Destination | Works | Missing |
| --- | --- | --- |
| **Search** | ✅ | — |
| Tagger | ✅ *(queries routed 10g, driven 2026-08-30; the two refresh commands stay desktop-only)* | `tag_children` |
| Decks | ✅ *(routed 10b/10c, driven on the phone 2026-08-30)* | `deck_folder_list`, `deck_list` |
| Collection | ✅ *(routed 10d, driven 2026-08-30)* | `collection_list` |
| Wishlist | ✅ *(routed 10e, driven 2026-08-30)* | `wishlist_list` |
| Settings | ❌ *(routed 2026-08-30 - PR 10h; `update_history` and `update_status` followed on 2026-08-31, and three of the four data clears with them; not yet driven on the device)* | `update_history`, `tags_muted`, `error_log_list` |
| The card pane, from Search | ❌ *(routed 2026-08-30 - PR 10f, the bug that started all of this; not yet driven on the device)* | `card_detail` — *"Could not read this card — unknown command `card_detail`"* |

**Nothing regressed.** `web/route.rs`'s own doc has always said so: *"This is a first slice and not
the whole surface. The app has 152 commands; the four here are the browse."* The web target was
built as a browse and it is exactly that.

**What changed is that the browse became good enough to invite the next tap.** Before 9c the phone's
search wall showed 0.44 of a tile row and nobody got as far as pressing a card. With two columns and
two whole rows the natural next act is to open one — and that is where the slice ends. A layout that
works is what turned a documented boundary into a reported bug.

### The size of it, measured

| | |
| --- | --- |
| `#[tauri::command]` in the crate | **152** |
| Routed in `web::route::COMMANDS` | **4** (17 after PR 10b, below) |
| Modules gated `cfg(not(target_family = "wasm"))` in `lib.rs` | **31** |

The largest clusters are the deck domain — `deck.rs` 20, `deck_meta.rs` 19, `deck_theory.rs` 4,
`deck_undo.rs` 3 — then `desktop.rs` 10, `sync_pair/pairing.rs` 9, `collection_folders.rs` 8,
`wishlist_folders.rs` 8, `collection.rs` 7, `card.rs` 6.

**That table read 155 and 36 files when it was written on 2026-08-29, and both were wrong** —
corrected the same day. A `grep` for `#[tauri::command]` counts two things that are not
commands: **the seven `#[tauri::command(async)]` attributes**, which the pattern misses because
it wants the bracket immediately after `command`, and **the doc comments that mention the
attribute in prose** while explaining why a particular command is `(async)`, which it
over-counts. The two errors do not cancel. `route.rs`'s own header had said **152** all along
and was right; the recount replaced a correct number with a wrong one, which is the argument
for [not writing down a number a build already answers](../../CLAUDE.md). Counted properly by
a script that skips comment lines and matches both spellings: **145 bare + 7 `(async)` = 152,
across 32 files.**

### Decided 2026-08-29: all of them except ten, by destination, worst-broken first

**The ten that stay desktop-only are the ones §6.3 already named**, and the reason each is not a
port but a different feature:

- **`mirror/settings.rs`, 4.** The plain-text mirror writes a folder on disk *for other programs to
  read*. In OPFS nothing else can read it, so a web mirror would be the feature's name without the
  feature. **Reduced from five to four on 2026-08-31**, and the fifth was not ported — it was
  replaced: `mirror_backup_zip` renders the same files on demand and hands the page one archive,
  which is what a browser *can* deliver. `mirror_status`, `mirror_set_enabled`, `mirror_set_root`
  and `mirror_rebuild` are the folder and stay here.
- **`desktop.rs`'s updater, 5** — `update_check`, `update_download`, `update_apply`,
  `update_history`, `update_open_release_page`. The portable updater swaps an `.exe`. **A PWA
  already updates through its service worker**, which ships and works; routing these would be a
  second answer to a question already answered.

On web those ten are hidden rather than broken, through the seam `SettingsPage` already uses to
hide the Backup panel on Android.

> **Revised 2026-08-31 — the ten are eight, and the second bullet was two claims wearing one
> sentence.** "A PWA updates through its service worker" is true, and it settles `update_download`,
> `update_apply` and `update_open_release_page`: those replace a file, and nothing in a browser
> should. It does **not** settle `update_history`, which is two `app_meta` reads and no network at
> all, or the *version* half of `update_status`. Both are routed now.
>
> **And "hidden rather than broken" turned out to be the wrong half of the fix**, which is what
> PR #315 found on the phone and what the next section records: hiding a panel because the backend
> cannot answer is the same mistake as gating a feature on an answer that never arrives. The
> backend answers.
>
> **`update_check` is the one that is neither routed nor merely waiting**: it cannot be a
> `match` arm in `web::route::call` at all, because that function is synchronous — the Worker's
> `#[wasm_bindgen] call` is — and it reaches the network. See below.

**The remaining ~142 are ports, and most are one shape**: lift the pure function out of the `cfg`
gate into a module that compiles everywhere, then add a `match` arm to `web::route`.
[`image_uri.rs`](../../src-tauri/src/image_uri.rs) is the worked example — it was carved out of
`images.rs` for exactly this reason when the search DTO needed it on web.

## PR 10a: the gate was in the wrong place, and moving it cost almost nothing

**Shipped 2026-08-29.** Eleven modules — `collection`, `collection_alloc`,
`collection_folders`, the five deck modules, `marketplace`, `wishlist`, `wishlist_folders` —
now compile for `wasm32-unknown-unknown`. **No command is routed by this change and no
behaviour moved on any target**; what it buys is that the next PR can add `match` arms
instead of arguing with the module system.

**The finding that made it cheap: those modules were never desktop-only in their content.**
Each file ends in a contiguous block of `#[tauri::command]` wrappers and is pure SQLite above
it — `deck.rs` has **no `tauri::` reference in its first 3 991 lines**, and `deck_list` is six
lines around `list_decks(&conn)`. The gate sat on the *module* because that is where the
commands are. `search.rs` had the other arrangement all along: ungated module, gate on each of
its two commands, which is exactly why `run_search` is reachable from `web::route` and
`list_decks` was not. **So this was moving a gate, not writing a port.**

### Measured, and reproducible by ungating a module and running `cargo check`

| Ungated | wasm errors |
| --- | --- |
| The whole domain at once (22 modules) | **93** |
| The deck cluster + collection + wishlist (11 modules) | **19** |
| …after the `app_meta` carve-out | **13** |
| …after gating five `unfinished` helpers and the covers seam | **0** |

**The covers seam in that last row no longer exists to gate**, and the row is kept as the
measurement it was. Custom deck covers went on 2026-08-31, so `deck.rs` reaches nothing in
`images.rs` any more and the `covers: Option<&Path>` parameter it was all threaded through is
gone from `delete_deck`, `duplicate_deck` and `clear_decks` alike. Re-running the experiment
today would reach **0** one gate sooner; nobody has re-run it, and the number to compare against
is the one above.

Of the 93, **44 were `cannot find module or crate 'tauri'`** — helpers *outside* a command
wrapper, almost all of them the one-line `fn unfinished(e: tauri::Error) -> String`. Those are
mechanical. The rest split into the four modules below and the cascade between siblings.

### Three seams, and one of them was a module in the wrong place

- **`app_meta` was inside `update.rs`.** `crate::update::get_app_meta` is a key–value settings
  read that **eleven modules** call — `deck` keeps the search column's state in it, `zoom`,
  `nav`, `listview` and `flatten` keep view state — and it was living in the module that swaps
  an `.exe`. Now [`app_meta.rs`](../../src-tauri/src/app_meta.rs), ungated, with all **61** call
  sites moved. **A `pub use` re-export from `update` was tried first and does not work**: a name
  re-exported from a gated module is invisible on wasm exactly when it is needed.
- **Covers — the seam that no longer exists, kept because it is the clearest of the three.**
  `deck.rs` called `images::{cover_file, write_cover, remove_cover, copy_cover}`, every one
  reached through a `covers: Option<&Path>` that was `None` on web. Gated rather than stubbed —
  a `write_cover` that silently did nothing would be a cover that looks saved and is not.
  `copy_cover_file` was restructured into a two-arm `copied_cover` helper, which retired an
  `.expect("a copy cannot have happened without a directory")` by putting that argument in the
  return type instead of in a panic message.
  **All four functions, the parameter and the helper were deleted on 2026-08-31** with the custom
  deck cover itself: a cover is `decks.cover_card_id` now, which is a string every target already
  syncs and draws. The seam is worth reading anyway, because the *shape* recurs — a domain module
  reaching a filesystem module through one optional path argument — and because the resolution
  here is the third option neither "gate" nor "stub" names: the feature the seam existed for
  turned out to be one the other targets had already been doing without.
- **`marketplace::set_marketplace_now` reads `AppState.mirror`.** The *setting* is every
  target's and `deck_meta`'s readback quotes it; telling a mirror about a change is not.

### The compiler names the download/query seam through `AppState`

**Four modules are a split rather than a port, and none is done**: `images.rs`, `update.rs`,
`marketplace_feed.rs` and `tags/mod.rs`. Each mixes *downloading a thing* with *reading the
thing already downloaded*, and the errors say so precisely — on wasm **`AppState` has no
`client` field and no `mirror` field**, so every failure in those four is the download half
asking for a capability the web target does not have (plus `tokio`, the `image` crate and
`zip`). `image_uri.rs` and now `app_meta.rs` are both that split already done. **That is the
map for the rest of PR 10 and should not have to be re-derived.**

### What the two remaining dependency facts cost

- **There are no leaf modules.** `collection` and `wishlist` import `deck_meta`, and
  `collection_alloc` calls into `deck` and `deck_audit` — the cluster is mutually recursive, so
  the eleven move as one atomic change or none do. A plan that plans to do the "leaves" first
  is wrong, and this one did until the compiler said otherwise.
- **`-D warnings` on the wasm clippy job makes a stranded import a red build**, and moving a
  gate strands them constantly: **22 `use` statements** needed gating and **9 private helpers**
  needed `#[cfg_attr(target_family = "wasm", allow(dead_code))]`. That attribute rather than a
  `#[cfg]` is deliberate and follows `sync::with_write` — those helpers are what `web::route`
  will call, so keeping them *compiling* is the point.

## PR 10b: the Decks reads are routed — `COMMANDS` goes from 4 to 17

**Shipped 2026-08-29**, on top of 10a. Thirteen `match` arms, one file, and **no frontend
change at all** — `src/lib/ipc.ts` is a flat mirror calling `invoke("deck_list", …)` through
`@/lib/core` with **no allowlist on the TS side**, so the Decks page had been asking for these
commands and failing all along.

```
deck_list          deck_get            deck_folder_list   deck_category_list
deck_tag_list      deck_tag_all        format_specs_list  deck_last_format
deck_search_open   deck_audit_list     deck_theory_slots  deck_theory_diff
deck_undo_state
```

**The write path is deliberately a separate PR.** A read that answers the wrong rows is visible
on the page; a write that lands wrong is not.

### Two things the arms had to get right that a type check cannot see

- **The argument keys are camelCase, and the wrapper is the specification.** `invoke` matches a
  command's parameters by name and `ipc.ts` sends `{ deckId, variant, marketplace }`, so an arm
  reaching for the Rust spelling `deck_id` compiles, type-checks, and answers
  `RouteError::Args` on every real call — which reads as a bug in the page.
  `the_deck_arms_read_the_camel_case_keys_the_page_sends` pins both directions: the camelCase
  key works *and* the snake_case one is refused, because a pin that only asserts the first is
  satisfied by an arm that accepts everything.
- **An omitted optional argument is the ordinary call.** `field` requires the key to be
  present, and JavaScript sends an unset optional as a **missing key** rather than as `null` —
  so every `marketplace`-taking arm built on `field` would refuse the default read with
  "missing `marketplace`". Hence `optional`, which treats absent and `null` alike and still
  errors on a value that is present and unreadable.

### One command was not a thin wrapper

**`deck_undo_state` held its logic inside the `#[tauri::command]`** — three lookups and a redo
filter — rather than in a function the command called. It is the only read in the deck cluster
shaped that way. Lifted to `deck_undo::undo_state(conn, deck_id, redo_id)`, which both the
wrapper and the arm now call; a `match` arm that re-spelled it would have been a second copy of
the redo rule waiting to drift.

### `category_for_name` is not a command, and a grep says it is

It appears in a `grep -A3 '#\[tauri::command\]'` of `deck_meta.rs` because **its own doc comment
contains that string** — in the sentence *"never a command in its own right — it is not in this
module's `#[tauri::command]` list."* Reading it as one would have produced an arm for a function
the page never calls. This is the same over-count that made the command total read 155 instead
of 152, and the same reason `deck_meta.rs` is **19** commands rather than 20.

### Mutation-checked, three ways

| Mutation | Caught by |
| --- | --- |
| A name in `COMMANDS` with no `match` arm | `every_advertised_command_is_actually_routed`, by name |
| `"deckId"` → `"deck_id"` in an arm | `the_deck_arms_read_the_camel_case_keys_the_page_sends` |
| `optional` made strict | `an_omitted_optional_argument_is_not_an_error`, plus two others |

**The first attempt at the third mutation was worthless and is worth recording**: deleting the
`None` pattern made the `match` non-exhaustive, so the *compiler* caught it and the test never
ran. A mutation has to leave the code compiling, or it measures rustc rather than the suite.

## PR 10c: the Decks write path — `COMMANDS` reaches 50, and the deck cluster is done

**Shipped 2026-08-29.** Thirty-three more arms, so the whole deck cluster is routed except one.
`COMMANDS` is **50 of 152**.

**`deck_set_cover_image` was the eleventh name on §6.3's desktop-only list**, and it was not
"not yet": it wrote a file into a covers directory, and `deck::set_cover_image` did not compile
for wasm at all. Every *other* covers-touching command routed, because `delete_deck` and
`duplicate_deck` took `covers: Option<&Path>` and web passed `None` — the answer that parameter
was shaped for.

**It was deleted on 2026-08-31 rather than ported, and the deck cluster is now routed without an
exception.** Custom deck covers went whole: a cover is `decks.cover_card_id`, a card id that is
already an ordinary synced string and already draws identically here. The `covers` parameter went
with the command, so `delete_deck`, `duplicate_deck` and `clear_decks` take nothing — there is no
longer a `None` for this target to pass, which is a smaller `route.rs` and one less thing a
future arm can get wrong. The sentence about §6.3's eleventh name is kept because that list is
what the port was planned against, and because "the one deck command that could not follow" is
the shape of argument worth recognising again, not because the name is still on it.

### `with_write`, and a guard that only guards one target

Every write arm goes through `crate::sync::with_write`, never `lock_db_read`.
`a_deck_created_through_the_route_is_there_when_the_route_is_asked_again` catches the
substitution — measured, it fails with *"attempt to write a readonly database"*.

**But that guard is a desktop guard, and this is the caveat to know before trusting the green
suite.** On the desktop `db_read` is `SQLITE_OPEN_READ_ONLY`, so the mistake is loud. **On wasm
`lock_db_read` hands back the write connection** — this module's own header says so — so the
same arm would commit happily there and cost only what `with_write` adds: the busy answer and
the cross-file fence. `cargo test` runs on the desktop, so the test is real; it is simply not
running on the target the bug would ship to.

The assertion is a **read-back through the route**, not an `is_ok()`, for the related reason: a
command that answered `Ok` and committed nothing would satisfy the weaker check forever.

### One helper stopped being dead

`deck_undo::apply_reversal` was one of the nine private helpers PR 10a marked
`#[cfg_attr(target_family = "wasm", allow(dead_code))]` on the argument that they were what
`web::route` would call next. It is now `pub(crate)` with two real callers and the attribute is
gone — which is the intended lifecycle of that marker rather than an exception to it. **Eight
remain**, and each is a command not yet routed.

## PR 10d: the Collection destination — `COMMANDS` reaches 67

**Shipped 2026-08-29.** Seventeen arms: the seven collection commands, the eight folder
commands, and **the pair that moves a row across the deck boundary** (`collection_to_deck` /
`deck_to_collection`), which belongs here because both ends of it are a collection write.

### `route::call` now takes `&Arc<AppState>`, and the collection is why

Every write to `collection_entries` goes through
[`collection_source::with_write_owned`](../../src-tauri/src/collection_source.rs), which takes
the `Arc` because it hands it to `index::lifecycle::invalidate_owned` after a successful write.
The alternatives were both worse: re-spell that helper's two steps in each of the seven
collection arms — two copies of a rule that must agree, which this repo has been bitten by — or
use the plain `with_write` and leave the search's **owned facet stale after every web write**, a
wrong count rather than an error.

**It cost nothing.** `glue.rs` already held an `Arc` and passed `&app` either way, and
`&Arc<AppState>` derefs to `&AppState`, so **not one of the fifty existing arms changed**.

### Which helper an arm uses is read off its wrapper, never guessed

`collection_folder_delete` is the trap. It re-files every row in the folder it deletes, so "it
touches entries, therefore it needs the owned helper" is the obvious inference — and it is
wrong. Those rows keep their quantities, nothing the owned index counts changes, and the
wrapper uses plain `with_write`. `collection_set_folder` sits beside it using the *owned*
helper, because it moves an entry rather than a folder.

### The import commit is a port; the file read is not

`collection_import_commit` takes already-parsed items, so it routes like anything else.
`import_read_file` is the one that needs the browser mechanism §6.2 specifies, and it is not
here. Separating those two is what makes "import needs file handles" a statement about one
command rather than about the feature.

`collection::commit_import` was the second of PR 10a's nine markers to come good — now
`pub(crate)`, attribute gone. **Seven remain.**

## PR 10e: the Wishlist destination — `COMMANDS` reaches 81

**Shipped 2026-08-30.** Fourteen arms, six for the wishlist and eight for its cabinet. The same
shape as the collection with **one deliberate difference: plain `with_write` throughout.**

**A wish is something the reader does *not* have**, so nothing written here changes what is
owned and the facet index has nothing to invalidate. Reaching for `with_write_owned` because
the two destinations look alike would rebuild the owned index on every wish edit — wasted work
rather than a wrong answer, but wrong about what the two lists mean. The wrappers already
encode this; the arms copy them rather than reasoning from the resemblance.

`wishlist::commit_import` is the third of PR 10a's nine markers to come good. **Six remain.**

## PR 10f: the card pane — the reported bug is fixed, `COMMANDS` reaches 87

**Shipped 2026-08-30.** `card.rs` moves to "Every target" and its six commands are routed. **This
is the PR that answers the bug that started PR 10**: on 2026-08-29 a card tapped on the phone
gave *"Could not read this card — unknown command `card_detail`"*.

`card_detail` is one `match` arm and always was. What it was waiting for is the same thing the
deck domain was waiting for — the module compiling for the target — and `card.rs` needed no
work at all to get there: **no filesystem, no `tokio`, no `reqwest` anywhere in its 2 146
lines**, six command wrappers, and everything else `&Connection` in and a DTO out. The gate
move cost two gated imports and one `pub(crate)`.

`card_image_uri` is routed and **its answer is one the browser cannot fetch** — an `mtgimg://`
URI, whose protocol handler is a Tauri webview thing. Routing it anyway is deliberate: the
command's job is to resolve *which* picture a printing has, and the page decides what to do
with that. On web `src/lib/images.ts` builds a `cards.scryfall.io` URL from the same two
columns and goes through the service worker, so this arm is not what makes an image appear —
it is what stops the call being an `unknown command` in the console while the page works.

Two tests: the reported call answering `Lightning Bolt` with its camelCase DTO intact, and an
unknown id answering `null` rather than an error, which is the shape the pane draws an empty
state for.

## PR 10g: the Tagger — ten of twelve, and the two left out are the two that download

**Shipped 2026-08-30.** `COMMANDS` reaches **97 of 152**. This is the first destination where
the module genuinely split rather than simply moving, which is what PR 10a predicted for
`tags/` and three others.

**Routed (10):** both `*_status`, `oracle_tags_for_cards`, `oracle_tags_for_printings`,
`tag_search`, `tag_children`, `tag_resolve`, `tags_muted`, `tag_mute`, `tag_unmute`.
**Not routed (2):** `oracle_tags_refresh`, `art_tags_refresh` — they fetch a bulk file through
`state.client`, a field wasm's `AppState` does not have, and report progress through an
`AppHandle`.

**What the ten buy is the documented fallback instead of an error.** A database that has never
fetched a taxonomy is a supported state — the Tags page "says so and still answers from the
oracle side" — and the web target could not previously *reach* that state, because
`tag_children` was an unknown command. Both `*_status` arms now answer honestly on a browser:
`ingestedAt: null`, `stale: true`, `refreshing: false`.

### `SystemTime::now()` would have panicked the Worker, not failed

`status_of` — which backs both `*_status` commands — called `unix_now()`, and
**`SystemTime::now()` panics on `wasm32-unknown-unknown`**. Routing the status commands without
noticing would not have produced an error the page could show; it would have taken the Worker
down. `tags::now_from(conn)` reads `SELECT unixepoch()` instead, following
`sync_engine::entitlement::now`, and `unix_now` is now gated as ingest-only. `tag_mute` needed
the same treatment, because a muted row carries a timestamp.

**This is the sharpest argument yet for the module map's rule about `SystemTime`.** It is in
`src-tauri/CLAUDE.md` because it is invisible: it compiles, it passes every desktop test, and
it fails only in a browser, loudly and unrecoverably.

### One assumption the compiler corrected

`Dataset::bulk_name` looked like pure download data and was gated off the web target — wrongly.
Its own doc says it is *"the `/bulk-data/{name}` entry to check, **and** the `operation` a
failure is logged under"*, and `is_refreshing(ds.bulk_name)` reads it on the **status** path.
It is an identity, not a URL. The real problem was only that its *value* came from the gated
`scryfall`, so each dataset now owns its `BULK_NAME` and **`scryfall` aliases that** rather than
holding a second copy — one definition, no drift possible.

### Nine items gated as ingest-only

`RefreshGuard` and its `Drop`, `claim`, `temp_path`, `note_failure`, `closure_is_populated`,
`DOWNLOAD_EMIT_BYTES`, `mark_checked`, `unix_now`. `is_refreshing` stays ungated and always
answers `false` on a browser, which is correct rather than a stub: nothing there can ever claim
the registry.

**One test caught its own fixture, which is worth keeping.** The first draft of
`a_wish_added_through_the_route_is_listed_by_it` sent `{ name, quantity }` and got
`Failed("a wish needs either a card or an oracle id")` — the command's own sentence, arriving
through the route unchanged. The arm was right and the test was wrong, and the failure said so
precisely enough to fix in one edit. That is what `RouteError::Failed` carrying the command's
words rather than a generic message buys.

**Three families are not that shape** and need a browser mechanism that does not exist yet:
`import`/`export`'s file handles (spec §6.2 already specifies `<input type=file>` and a `Blob`
download), and `reset`'s OPFS deletion.

**The order is by destination, worst broken first** — Decks, then Collection, Wishlist, the card
pane, Tagger, Settings — so that every PR makes one nav destination genuinely work and can be
driven on the phone. It front-loads the deck domain, which is the biggest cluster and where the
surprises will be, and that is deliberate.

## PR 10h: Settings — `COMMANDS` reaches 111, and every destination is routed

**Shipped 2026-08-30.** Fourteen arms: the four view-state pairs (`nav`, `zoom`, `listview`,
`flatten`, all four modules moved left), both `error_log` commands, both `marketplace` ones,
and Commander Spellbook's two queries.

**`error_log_list` and `error_log_clear` live in `desktop.rs`**, which can never compile for
wasm — it is the Tauri app's own setup. Nothing needed lifting: they are thin over
`errors::list`/`errors::clear`, and `errors` has been ungated all along.

**`set_marketplace` routes to `store`, not to `set_marketplace_now`.** That wrapper is `store`
plus `state.mirror.mark_all()`, because changing the marketplace changes what every mirrored
CSV would say — and a browser has no plain-text mirror to re-render. The pure half is the whole
of the feature on this target rather than a reduced version of it.

**`combos::status_of` had the same `SystemTime::now()` trap `tags` did**, found the same way
and one command later: it was gated *and* called `unix_now()`, so routing `combos_status`
against it would have panicked the Worker. Its clock now comes off the connection too. **Two
modules, one day, the same latent crash** — which is the argument for the module map's rule
being stated as a rule rather than left to be noticed.

## Driven on the phone, 2026-08-30: every destination works, and the pass found one bug

**OnePlus, Chrome 152, portrait, 360×696, against a production build of PR 10's whole queue with
the 117 606-card corpus already in OPFS.** Each nav destination opened in turn and its `main`
scraped for `unknown command`, then a card tapped from the wall.

| Destination | Before PR 10 | After |
| --- | --- | --- |
| Search | ✅ | ✅ |
| Tagger | `tag_children` | ✅ *"No tags picked yet"* — the documented never-fetched state |
| Decks | `deck_folder_list`, `deck_list` | ✅ folder tree and `All decks 0` |
| Collection | `collection_list` | ✅ `Cards 0` |
| Wishlist | `wishlist_list` | ✅ `Wishes 0` |
| Settings | `update_history`, `tags_muted`, `error_log_list` | ✅ |
| The card pane | **`card_detail`** | ✅ formats, printings, artist, both printings priced |

**The reported bug is fixed on hardware**: tapping a card opens the pane with its legality list,
`PRINTINGS`, the artist, two printings with set, year and price, and the Scryfall attribution.

### The one thing the pass found that no test could

**`update_history` was still on screen** — the only `unknown command` left in the app after 114
commands were routed — printed on the Settings page, where §6.3's ten desktop-only commands are
supposed to be *hidden rather than broken*.

Three things were wrong and each hid the next:

- **`SettingsPage` rendered `UpdatePanel` unconditionally.** Now `!isWebTarget()`.
- **`useReleaseHistory` ran unconditionally**, which is what produced the visible error. Now
  `enabled: !isWebTarget()`, and `loading` reads `fetchStatus !== "idle"` because a disabled
  TanStack v5 query stays `pending` for ever and would otherwise report "loading" permanently.
- **`useUpdate` polled `update_status` every minute for the life of the tab** and swallowed each
  failure in a `catch` whose comment explains why one failure does not matter. Now it returns
  early on the web target.

**The panel's own guard could not have caught this, and that is the general lesson.** It tests
`installKind === "managed"` — an answer from `update_status`, which is *itself* desktop-only. On
a browser that answer never arrives, so the panel concluded it was **not** managed and drew the
controls. **A feature gated on a backend answer is ungated wherever the backend cannot answer**,
which is the opposite of the intended reading, and it is invisible to every test that has a
backend.

### Two operational notes, both of which cost time here

- **The service worker served the previous build and the first sweep read exactly like a failed
  port** — all six destinations still reporting the same `unknown command`s as before PR 10. It
  was the PWA shell doing its job. Clearing `caches` and unregistering the worker, then
  reloading, is what showed the new bundle; the **shell cache's build id is the tell**
  (`grimoire-shell-<id>`), and it changing is proof the reload took.
- **`navigator.serviceWorker.getRegistrations()[].unregister()` can hang** over CDP once a new
  worker is waiting. Closing the tab and opening a fresh one is the reliable move, and it is also
  the flow the app's own update actually uses.
- **OPFS is untouched by any of that.** The 117 606-row corpus survived every cache clear and
  every reload — a different storage API, so a shell-cache bust costs nothing but a re-fetch of
  the bundle.

## Where PR 10 got to: 120 of 155 routed, and what the other 35 are

**Do not hand-count this — run `node scripts/routed-census.mjs`.** It walks every
`#[tauri::command]` in the crate (both attribute spellings, skipping doc-comment mentions),
diffs against `COMMANDS`, and prints exactly the grouping below. `--check <n>` exits non-zero
when the routed count has moved, so a stale table can be caught by running one command instead
of by noticing.

**That script exists because this table has already rotted three times, in every direction.** It
read **155** when the answer was 152 (a coincidence with today's total, and worth naming as one
before it is read as continuity) — a grep counted the doc comments that *mention* the
attribute while explaining why a command is `(async)`, and missed the seven
`#[tauri::command(async)]` spellings, and the two errors did not cancel. Then it read **156 / 36**
for a day after `sync_group_leave` landed on another branch. Then it read **157 / 37** from
2026-08-30 until the card-art-only cover work re-derived it on 2026-08-31, and *that* one is the
instructive rot, because the script had been sitting in the repo the whole time: the number was
written by hand anyway, and the hand was one out on the crate total **and** one out on
`sync_pair/pairing`, which has nine commands and was tabulated as ten. **A prose-only edit routes
to neither CI job**, so none of the three made anything go red; every one was found by
re-deriving the number rather than by reading it. Do not hand-count the row breakdown either —
the script prints it grouped by file, which is the grouping below.

The crate has grown during this work and each step is somebody else's commit rather than a
miscount: 152 on 2026-08-29, 154 once the hosted-relay work landed, and 156 with the backup
archive's two — `sync_group_leave` is inside that last figure rather than a fourth step on top of
it, which is where the stray **157** came from. It has now shrunk once, to **155**, which is the
first time that has happened: `deck_set_cover_image` was deleted with the custom deck cover on
2026-08-31.

| | |
| --- | --- |
| Commands in the crate | **155** |
| Routed | **120** |
| Not routed | **35** |

**Re-derived 2026-08-31 after custom deck covers were removed.** The routed figure did not move
and could not have: `deck_set_cover_image` was never in `COMMANDS`, so deleting it takes one off
each of the other two columns and leaves 120 where it was. `COMMANDS` membership is what this
script counts, and it is *not* the same question as "does the web target answer this command".
**Five of the 35 below are served through `glue.rs` instead** — the four `*_refresh` and
`update_check` — because each is `async` and makes a network call while `route::call` is
synchronous and makes neither. `src/lib/core/browser.ts` diverts those five names, so a panel
calling one reaches the export in a browser and the Tauri command on a desktop. Read the rows
below as "not a `COMMANDS` arm", never as "not available"; the "Why not" column says which of the
two each one is.

**The 35, and none of them is an oversight:**

| Count | What | Why not |
| --- | --- | --- |
| **16** | `sync_pair/pairing` (9) and `sync_engine/commands` (7) | The pairing and membership surface. `lib.rs` states `pairing` "does not and never will" compile for wasm; the relay work is live and moving, so this is its own decision rather than a port. **This row said 17 (pairing 10) until 2026-08-31 and pairing has had nine since `sync_group_leave` landed** — the miscount above, not a command that went anywhere |
| **5** | `desktop.rs` | Seven `update_*` commands plus `sync_run`, of which two are routed: `update_status` and `update_history` report rather than replace. Of the five left, **`update_check` is answered by `glue::update_check`** and only four are genuinely absent — `update_download`, `update_apply`, `update_open_release_page` (they stage, swap and relaunch an `.exe`, or open a URL through a Tauri plugin) and `sync_run`, whose ingest is `glue.rs`'s own |
| **1** | `cache_clear` | Three of `reset`'s four clears were routed on 2026-08-31 — they are pure SQLite and always were. `cache_clear` sweeps a directory of image files, which on this target is Cache Storage, so it is **answered by the service worker** rather than by an arm — diverted in `src/lib/core/browser.ts` the way the four `*_refresh` are, and pinned out of `COMMANDS` by a test. **This row was `cache_clear, deck_set_cover_image` and counted 2**; the cover command was deleted outright on 2026-08-31, so the one thing here a browser had no directory for is now the only thing here |
| **4** | `mirror/settings.rs` | These four *are* the folder — where it is, whether it runs, when it last ran, rebuild it now — and a folder in OPFS cannot be read by the programs a mirror exists for |
| **1** | `mirror_backup_save` | Android's door onto the same archive `mirror_backup_zip` routes: it writes at a destination a save dialog answered, which a browser has no way to name. Not a gap — the browser's door is the routed one |
| **2** | `import_read_file`, `export_write_file` | §6.2's `<input type=file>` and `Blob`. The count in this row is unchanged, but **the seam behind it went from three commands to two** on 2026-08-31 — `deck_set_cover_image` took a picked path exactly as these do, and was tabulated up beside `cache_clear` instead, because a browser's missing *covers directory* was the louder reason. `picked.rs`'s module doc and [android-target.md](android-target.md)'s §4 are the other two places that "three" was written down |
| **4** | The four `*_refresh` (oracle tags, art tags, combos, marketplace feed) | Each is `async` and downloads — so each is a `#[wasm_bindgen]` entry in `glue.rs` with its name diverted in `browser.ts`, and **all four work**. PR 11 |
| **2** | `images.rs` | The byte cache is Cache Storage on web — a rewrite, not a port |

**PR 10i closed the last two gaps**, so every one of these is a decision with a reason above it
rather than something nobody got to. `marketplace_feed` got `tags`' split — the
status query kept, the download gated — and `import` got the same: `import_resolve` and
`deck_import_commit` are ordinary SQLite, and only `import_read_file` ever needed a file
handle. **The page can already paste a decklist without touching a file**, so those two are the
whole of the import that works on this target.

**And the same clock trap a third time.** `marketplace_feed`'s status path used `unix_now()`,
like `tags` and `combos` before it. Three modules, one day, one latent Worker crash each. The
arm reads `SELECT unixepoch()` off the connection like the other two.

**One near-miss worth recording**: the first attempt fixed `marketplace_feed::status_of`, which
looked like the status command's function and is not — that one belongs to `refresh`, and the
command maps `PROVIDERS` over `read_status` itself. The fix compiled, passed, and would have
left the actual command still calling the panicking clock. **A name matching is not a call
graph**; the wrapper is.

---

## PR 11 — the three optional feeds download in a browser

**Shipped 2026-08-31.** `combos_refresh`, `oracle_tags_refresh`, `art_tags_refresh` and
`marketplace_feed_refresh` work on the web target. The line in the table above that reads
"Each downloads through `state.client`" is now the *history* of those four rather than their
state.

**`COMMANDS` did not move, and that is the point.** A refresh is `async` and makes a network
call; `web::route` is synchronous, takes the connection and makes neither. So the four are
`#[wasm_bindgen]` entries beside `ingest_cards` — `ingest_combos`, `ingest_tags` (one function
for both taxonomies, because `tags/` is one engine with two bindings) and `ingest_prices` —
and `src/lib/core/browser.ts` diverts the four command *names* onto them. Nothing above the
core knows: `ipc.combosRefresh(true)` reaches the export in a browser and the Tauri command on
a desktop, `ipc.onCombosProgress` reaches the same `combos:progress` channel on both, and no
Settings panel grew an `isWebTarget()` branch.

### What each ingest needed

| Feed | Desktop | What the browser needed |
| --- | --- | --- |
| Combos | `combos::StreamRead`, already push-shaped | A TypeScript caller, and progress |
| Oracle / art tags | `tags::ingest_gz`, a **path** and a pull loop | `tags::StreamTags`, a push sink; `ingest_gz` is a 64 KiB read loop over it |
| Price feeds | `read_document`, a pull parser | `marketplace_feed::StreamRead`, `Elements` plus a head scrape |

**Both new sinks are `crate::ingest::StreamIngest`'s arrangement.** One drain, two drivers: the
state the read loop kept in locals moves into the sink, the file driver becomes a read loop,
and the browser writes the other driver. The desktop's numbers do not move — the tags
equivalence test drives the same fixture through both drivers and compares `TagStats` and every
closure row.

**The price feed's pull parser could not be shared and its pricing rules had to be.**
`read_document` calls `read()` when it wants more and blocks; a browser stream is push and
async with no thread to block. So `FeedProvider` grew `fold_element`, and both entrances decode
into the same `CkRow`/`MpRow` and call the same `ck_fold`/`mp_fold`. Mutating the etched-before-
foil order fails the pull test *and* the push test, which is the check that the fold is really
one copy.

### Three things this found

**`Elements` never noticed the array's closing `]`.** It framed every depth-0 object in the
*rest* of the document as though it were an element — and Card Kingdom's pricelist carries keys
after `data`. It produced no wrong price (those objects carry no `scryfall_id`) and inflated
`rows_seen` and `skipped`, so the only way it showed was the push and pull readers disagreeing
by one row. The combo document has the same shape and had the same latent bug.

**Both framers returned `Ok(())` for ever while accumulating.** That is exactly the spike's
failure — 63 elements in 610.2 MB, the buffer grown to 609.82 MB, **no error** — and
`peak_buffer()` only *reports* it afterwards. `Elements::push` and `Lines::push` answer
`Result<(), Overlong>` now and refuse past **8 MiB**, four times the largest peak this repo has
measured (2.01 MB against the real combo document), so a legitimate feed cannot reach it while
a desynchronised framer passes it within a document's first few chunks. Every caller lifts it
through `io::Error` into the `Io` variant its own enum already has.

**A size guard whose test could not fail.** `StreamRead`'s byte budget was first tested by
pushing non-draining bytes at the real 256 MiB cap — so the framer refused at 8 MiB and the
assertion accepted `TooLarge` *or* `Io`. Deleting the entire guard left it green. The budget is
a named constructor argument now (`StreamRead::with_limit`), because a document that *drains*
cannot trip the framer and 256 MiB of well-formed JSON is not a fixture.

### What the browser cannot do that the desktop can

- **No ETag, and therefore no 304.** A cross-origin `fetch` exposes no `ETag` response header
  unless the host names it in `Access-Control-Expose-Headers`, so every refresh here downloads
  where the desktop's would be one conditional request and no bytes. The weekly throttle is
  honoured instead of ignored — `force` skips it, exactly as on the desktop — and the tag
  ingest still stores the descriptor's `updated_at`, which is the *other* half of the desktop's
  freshness evidence.
- **No `mirror.mark_all()` after a price refresh.** There is no plain-text mirror in a browser,
  which is the argument `web::route`'s `set_marketplace` arm already makes.
- **No `error_log` row on a failed refresh.** The desktop's `note_failure` is on the gated
  download path; every failure here is a rejected promise the panel is already watching, which
  is `entitlement.rs`'s standing argument for the same omission — a press is on the screen of
  the reader who made it.

### Not verified

- **Nobody has run any of the three in a browser.** `cargo clippy --target
  wasm32-unknown-unknown` is silent, `npm run build:wasm` emits all seven entry points, and the
  suites cover both sinks on the host — but the sinks are what the suites reach, and `glue.rs`
  is compiled only for wasm and is therefore covered by nothing.
- **CORS is unproven for two of the three hosts.** Scryfall answers
  `Access-Control-Allow-Origin: *` (verified 2026-08-27), which is what makes the tag feeds
  plausible. `json.commanderspellbook.com` and `api.cardkingdom.com` have **not** been probed
  from a browser origin on this branch, and this page already records that **Mana Pool sends
  no `Access-Control-Allow-Origin` at all** (spec §5.3) — so `ingest_prices("manapool")` is
  expected to fail in a browser, and the export exists so that the failure is a sentence in the
  panel rather than an unknown command.
- **Neither tag feed has a UI caller on any target.** The backend refreshes them on its own
  weekly schedule and no button anywhere calls `oracle_tags_refresh` or `art_tags_refresh`, so
  the web path exists and nothing presses it. That is unchanged from the desktop rather than a
  gap this work opened.


## 2026-08-31: three of the four clears, and the Updates panel comes back

**`COMMANDS` reaches 119.** Two modules moved into the every-target block — `reset` whole,
`update` in half — and five arms went in: `collection_clear`, `wishlist_clear`,
`decks_clear`, `update_status` and `update_history`.

### `reset`: the gate was on the module and belonged on four wrappers

Measured by ungating the module and running `cargo check --target wasm32-unknown-unknown`:
**one error that is not a command wrapper**, and it is `clear_cache` reaching
`crate::images::Cache`. The other three clears are `&Connection` in and a DTO out, exactly
like the eleven modules PR 10a moved, and the four `#[tauri::command]`s at the foot of the
file are what was holding the whole thing on the desktop side. The gate moved onto them, and
onto the four imports only they and `clear_cache` reach.

**`cache_clear` stays unrouted, and it is a rewrite rather than a missing arm.**
`reset::clear_cache` takes a `&crate::images::Cache` and sweeps a directory of files; on this
target the byte cache is Cache Storage, which is the same call `lib.rs` has always made about
`images` itself. Until that lands, **the Local cache panel's button is the one control on the
Settings page that still answers `unknown command` in a browser** — which is a real gap and
is written here rather than left to be found on the phone. A test in `route.rs` asserts
`cache_clear` is *not* in `COMMANDS`, because the failure in the other direction is silent:
an arm added without the rewrite compiles on the desktop leg and takes the wasm build red on
a branch nobody ran `--target` on.

> **The gap in that paragraph closed the same day** — see *The last control on Settings* at
> the foot of this page. The rewrite landed in the page and the service worker; `COMMANDS` did
> not move and the `route.rs` test still holds, so everything above stays true except the
> sentence about the button.

**`decks_clear` passed `None` for its covers directory, and that argument was load-bearing.**
`clear_decks` handed it to `sweep_dir`, which deletes everything under it *recursively*. A
browser has no covers directory — `crate::paths` does not compile there — so `None` was the
true answer rather than a fallback, and there was no value this target could have passed that
would have been safe to sweep. The same argument is why no mutation test in this work was
allowed to change it: a cargo test binary's working directory is `src-tauri/`, and a previous
run of this task made `covers` resolve to that directory and deleted 93 source files.

**The parameter is gone as of 2026-08-31, and that incident is a named reason it went.**
Removing the custom deck cover took `clear_decks`'s `covers` argument, its `sweep_dir` call and
`DecksCleared::covers` with it, so *clearing the decks now touches no filesystem on any target* —
the one recursive delete that could be pointed somewhere unintended is no longer on this path at
all. `sweep_dir` itself stays: `clear_cache` still sweeps `data/images/` and `data/tmp/`, both of
which are named constants under the data directory rather than a parameter a caller supplies,
and both of which this target answers through the service worker instead. The paragraph above is
kept in the past tense because the reasoning — a `None` that is the truth rather than a stub —
is the pattern to copy the next time a desktop-only path has to compile here.

### `update`: §6.3 named the swap, and only the swap was ever permanent

**About two thirds of `update.rs` is now gated where it stands** — `Updater` and its
`BusyGuard`, `Staged`, `check`/`check_inner`, the whole download-verify-stage half, the
swap and the relaunch, plus nine constants and helpers that only they reach. `Updater`
itself is the hard stop: its `reqwest::Client` sets `user_agent`, `connect_timeout` and
`read_timeout`, none of which the wasm backend has — the same three `web::net` says it
cannot set.

**`SystemTime::now()` for the fourth time.** `unix_now()` is in this file's *Pure decisions*
section and is not portable at all: on `wasm32-unknown-unknown` that call **panics** rather
than failing, which arrives in the Worker's `onerror` with nothing the page can show. `sync`,
`tags` and `marketplace_feed` were each caught by it first. Here the fix is a gate rather
than a `SELECT unixepoch()`, because the only caller is `check_inner`, which is the desktop's.

`status` was split into `status_for(state, kind, busy, staged)`, which is the whole of what an
`Updater` was being consulted about. Everything else still comes off `app_meta`.

### The reason it is worth routing two commands that can answer so little

On web `available` is always `None` and `update_history` always `[]`, because only
`update_check` writes those rows and **`app_meta` is not one of the twelve synced tables** —
so no desktop check fills them in either. What a browser gets is the current version, the
install kind, and "not checked yet".

That is not the point. **The point is `installKind`.** `UpdatePanel` decides what to draw
from it, and while the command did not answer at all the panel read `undefined` as *not*
managed and drew a Download button over a page that can download nothing — the bug PR #315
found on the phone. #315 fixed it by hiding the whole panel behind `!isWebTarget()`, which
was right while nothing on the panel worked and is the same shape of mistake one level up:
a build-time constant standing in for an answer the backend could not give.

**`InstallKind::Web` is that answer**, and it is `Managed`'s sibling rather than a reuse of
it. Both mean "something else installs this and the app does not replace itself"; the reader
is owed the name of the thing that does, and "Updates arrive through Google Play" to somebody
at a laptop is the same wrong answer `Managed` exists to stop `Other` giving a phone. The
panel is on the page on every target again, and on web it is the About screen #315 said was
worth having: the mark, the name, the version, and one sentence naming the service worker.

### `update_check` is absent from `COMMANDS`, not broken and not "not yet"

`web::route::call` is **synchronous**, because the Worker's `#[wasm_bindgen] call` is. An
`async fn` cannot be a `match` arm there whatever it fetches with — so `update_check` cannot
be an arm, for the same underlying reason the four `*_refresh` commands are not.

> **This paragraph said "not attempted here" and was superseded the same day** — see
> *2026-08-31: the update check reaches a browser and a phone*, below. Its own next sentence
> was already stale when it was written: PR 11 gave all three feed refreshes a `ToWorker`
> kind, so `ingest_combos` had a caller.

That is the answer: a bespoke `async` `#[wasm_bindgen]` entry point with its own
`postMessage` kind in `src/workers/protocol.ts` and its own handler in `db.ts`, and the
command *name* diverted in `src/lib/core/browser.ts` rather than a branch in `ipc.updateCheck`.

### What the mutations found

Ten mutations, six in Rust and four in TypeScript; **none touched a path, a directory, or
anything reachable by `sweep_dir`**. Two survived and both were worth the round:

- **`useUpdate`'s status effect had no test at all.** Re-adding #315's
  `if (isWebTarget()) return` killed nothing — the file covered the three pure helpers beside
  the hook and stopped there. Without that effect the web panel has no `status`, so it cannot
  tell "a browser" from "not asked yet" and draws neither the version nor the sentence. Two
  tests now cover it: read once on web, keep polling everywhere else.
- **A `null` that could not be observed.** `elsewhere` was `null` for an absent status and
  `undefined` for a self-updating one, and nothing could tell them apart — both falsy, and
  `selfUpdating` short-circuits on `status` before reading either. Collapsed to `undefined`.

**And one defect the round found in the Storybook fake**: `pickAsset` read
`if (kind === "other") return null` and fell through to `NSIS_SUFFIX` for everything else, so
it handed a *managed* install the Windows setup — a mock encoding a state the backend refuses,
green for ever because nothing else in the workbench disagreed with it. It is an allow-list
now, like the Rust it mirrors.
---

## 2026-08-31: the last control on Settings — the cache clear works in a browser

**`COMMANDS` did not move, and this is the second time that has been the answer.** PR 11
diverted four command *names* onto `#[wasm_bindgen]` exports because a refresh is `async` and
downloads; this diverts one onto the **service worker** because the thing it deletes is not in
the database at all. `route.rs`'s `cache_clear_is_not_routed_while_the_image_cache_is_a_rewrite`
is unchanged and still passing: there is nothing for an arm over a `&Connection` to sweep.

| | Desktop | Browser |
| --- | --- | --- |
| `DELETE FROM image_cache` | the rows that vouched for the files | **nothing** — `images.rs` is gated out of the wasm crate, so no row has ever been written and `rows` is a truthful literal `0` |
| `sweep_dir(images)`, `sweep_dir(tmp)` | the byte cache on disk | every entry in the worker's `IMAGE_CACHE`, minus the ledger's own |
| `cache.forget_pending()` | the fetcher's in-flight set | no equivalent — there is no fetcher, the `<img>` is |

### The three pieces

- **`clearImages` in `src/pwa/imageLedger.ts`** deletes the pictures and hands back the ledger
  that describes what is left. **Both halves or neither**: a clear that emptied Cache Storage
  and left the stored ledger alone would leave the worker certain it was holding 256 MB of
  files that are gone, after which `evictions` deletes from an empty cache on every request for
  the life of the worker — `forget`'s failure reached from the other end.
- **The `CLEAR_IMAGE_CACHE` verb in `sw.ts`**, the fourth the worker answers. It goes through
  `mutateLedger` for `SET_IMAGE_CAP`'s reason and replies on `event.ports[0]` for `VERSION`'s:
  a `postMessage` back to the clients would answer every open tab rather than the one whose
  reader pressed the button.
- **`src/pwa/imageCacheClear.ts`**, the page half, which opens a `MessageChannel`, asks, and
  answers as the `CacheCleared` DTO the panel already reads. `CachePanel` and `useLocalCache`
  are untouched and cannot tell which target they are drawn on.

### Three things that are decisions rather than details

**A browser with no service worker is told nothing was cached, and that is the fact rather
than a shrug.** `npm run web:dev` registers no worker at all (measured, and in
[pwa-shell.md](pwa-shell.md)), and a private window may have none either — in both cases
nothing has ever written to `IMAGE_CACHE`, because the worker is its only writer. `files: 0`
prints *"There was nothing cached to clear."* through `cacheOutcome`, which is true. A
rejection was the alternative and would paint the panel red for a button that did exactly what
it should have.

**The controller is asked first and the registration second.** `navigator.serviceWorker.
controller` is `null` in three situations that are not the same thing: no support at all, a
first load before `clients.claim()`, and a document loaded *around* a perfectly good worker (a
shift-reload, devtools' bypass) whose cache is full. Only the last has anything to clear, and
`getRegistration()` is what finds it. **`.ready` is not used and must not be** — it never
resolves when there is no registration, which `PwaShell`'s comment records measuring.

**There is a timeout, because a worker that does not know the verb says nothing at all.**
`sw.ts`'s message handler is a chain of `if`s with no `else`. A reader who never presses the
update bar keeps the build they started the session with, by design (spec §5.4), so an older
active worker is a reachable state — and without the timeout the mutation stays `isPending`
for the life of the page: a Clear button that spins for ever with nothing on screen saying why.

### What the mutation round found

Eighteen mutations, all in Cache Storage arithmetic, the page-side helper or the core's
routing — **none of them touched a path, a directory, or anything reachable from `sweep_dir`**.
**Sixteen were killed on the first pass, seventeen after the repair below**, and the one
survivor is equivalent by construction:

- **A test that could not fail, which is the finding worth the round.** *"does not reject after
  it has already answered"* waited past the timeout and asserted the promise had not rejected —
  true whether or not the timer is cancelled, because rejecting a settled promise is a no-op.
  Deleting the `clearTimeout` left it green. It watches the cancel itself now, and kills that
  mutant.
- **A type-only fence, surviving because there is no behaviour to change.**
  `ClearableCache.delete` *requires* `{ ignoreVary: true }` rather than accepting it, so
  relaxing the interface alone leaves every call site passing it; dropping the argument was
  killed at once. The requirement stays, because `Cache.delete` runs the same matching
  algorithm as `Cache.match`: a stored response carrying a `Vary` the request disagrees about
  is **not deleted** and answers `false` — which this code would then report as a file that
  would not go.

### Two things found on the way

- **`sw.ts`'s `sweep()` deletes without `ignoreVary` — and that is a latent hazard with, by
  measurement, no current exposure.** This bullet first read *"a live correctness bug"*: the
  eviction path deletes by URL string, `Cache.delete` runs the same matching algorithm as
  `Cache.match`, so a stored response whose `Vary` disagrees refuses to be deleted while
  `forget` drops it from the ledger anyway — the cache then sits over its cap with no way back
  down. **That was inferred from the API contract rather than measured, and the measurement
  says the first condition never holds.** Probed live 2026-08-31 against `cards.scryfall.io`,
  the only origin `routeFor` sends to the image route: a real card image answers **200,
  83 658 B, `image/jpeg`, and no `vary` header at all** — the same three ways, plain, with an
  `Origin:` and with a webp-negotiating `Accept:`. `access-control-allow-origin` is a static
  `*`, which is *why* there is no `Vary: Origin` to begin with. A stored response with no
  `Vary` matches unconditionally, so the bare delete cannot fail for this reason today.

  **Narrower still, and worth writing down because it is the half that would change first.**
  Card art is a plain `<img>` — there is no `crossOrigin` anywhere in `src/` — so the request
  the worker stores is `no-cors` and carries no `Origin` header either; even a future
  `Vary: Origin` would compare `""` against `""` and still match. The only `Vary` that could
  ever bite here is one naming a header an `<img>` *does* send and a `new Request(url)` does
  not, which in practice means `Accept`.

  **The option was added anyway, and a reader must not take that for a bug fix** — there was
  never an incident here and going to look for one is wasted time. Two reasons, neither of them
  exposure. **The asymmetry fails silently and points somewhere else**: `image()` reads with the
  option and the eviction deleted without it, so if that origin ever negotiates — or
  `GRIMOIRE_IMAGE_ORIGIN` is aimed at a proxy that does — the read keeps matching while the
  evict quietly stops, and a cache growing past its cap names nothing that would lead anyone
  back here. **And it is the more correct call for this use**: the ledger is keyed by URL, so an
  eviction means *this URL is gone*, and ignoring `Vary` takes every variant of it — where the
  alternative evicts one variant and leaves the rest holding bytes the ledger no longer counts
  and nothing can reach again. Three lines of insurance at zero current probability.

  `swCore.test.ts`'s sweep now covers deletes as well as reads, and **the exclusion it rests on
  is asserted rather than assumed**: `caches.delete(name)` in `activate` drops a whole stale
  shell cache and takes no query options, and it escapes the delete family only because the
  character after `cache` is an `s` rather than a dot. A second test counts every delete in the
  file and demands the two families account for all of them, so a third spelling nobody
  classified fails there instead of slipping past the sweep unchecked. Four mutations, all
  killed: backing the option out, emptying the delete family, pointing the entry-delete pattern
  at nothing, and adding an unclassified third delete.
- **Two comments in `src-tauri/src/web/route.rs` have expired.** The `COMMANDS` block says the
  Local cache button *"is the one control on the Settings page that still answers `unknown
  command` in a browser"*, which is no longer true of any control; the test's own doc says the
  arm *"cannot exist until that is rewritten"*, and the rewrite happened somewhere the arm
  still cannot reach. **The assertion itself is right and must stay** — nothing about
  `COMMANDS` changed. Left alone here because this work is frontend-only and a `src-tauri` edit
  restarts every running `tauri dev`.

### Not verified

**Nobody has pressed the button in a browser.** The three suites cover the arithmetic, the
message helper and the divert, but `sw.ts` itself is unreachable from vitest — jsdom
implements neither `caches` nor a registration — so the message handler's wiring is guarded by
a **source sweep** in `swCore.test.ts` rather than by a test that runs it. What a live pass
would settle: that the reply arrives at all, that `files` matches what the wall put in the
cache, and that a picture whose response carries a `Vary` really does need the `ignoreVary`
this code passes. Use `web:build` + `vite preview`; a dev-server reading cannot answer any
question about this route.


## 2026-08-31: the update check reaches a browser and a phone

**"Check and notes, no download."** `update_check` answers on the web target and on Android;
`update_download`, `update_apply` and `update_open_release_page` stay the desktop's. What that
buys is not a Download button — `update::pick_asset` still refuses `InstallKind::Web` and
`Managed` — it is the **release notes and the version history**, which are written by the same
one request and by nothing else.

**That is why routing `update_status` and `update_history` earlier the same day was half a
feature.** `update_history` reads `app_meta.update_release_history`; the only writer of that
row is a check; `app_meta` is not one of the synced tables, so no *other* device's check fills
it in either. A browser's version history therefore answered `[]` permanently, and the panel
hid the section rather than draw an empty accordion. The section is drawn on every target now.

### `COMMANDS` did not move, for PR 11's reason exactly

`web::route::call` is synchronous, because the Worker's `#[wasm_bindgen] call` is, so no
`async fn` can be a `match` arm there whatever it fetches with. So this is
`glue::update_check` — a `#[wasm_bindgen]` entry beside `ingest_cards` and the three feed
ingests — with a `{ kind: "update-check", id, force }` message in `src/workers/protocol.ts`,
a handler in `db.ts`, and the command *name* diverted in `src/lib/core/browser.ts` by
`updateCheckForce`, `feedRefreshFor`'s sibling.

**`updateCheckForce` answers `boolean | undefined` and the `undefined` is load-bearing.** The
caller's test is *presence*: a bare `boolean` would make `updateCheck(false)` — a real,
throttle-honouring call — indistinguishable from every other command in the app, and every
`search_cards` would be posted as an update check.

**`node scripts/routed-census.mjs` reads 120 / 35, and the table above says why.** It counts
`COMMANDS` membership, which since PR 11 is not the same question as "does the web target answer
this". Five of the 35 are served through `glue.rs`. The routed half has not moved through either
change — PR 11 diverted names rather than adding arms, and the cover work deleted a command that
was never in `COMMANDS`.

⚠️ **This line said the script "still reads 120 / 37", which was true when written and was
false a few hours later — and the reason is the whole case for the script.** A first pass at
this note recorded it as a number guessed without running the command. It was not:
`git show fb512e5:src-tauri/src/sync_pair/pairing.rs` carries **ten** `#[tauri::command]`s, so
the crate really did answer **157 / 120 / 37** that day.

What moved it was **PR #324**, which landed the same afternoon and reshaped the pairing surface:
`sync_pairing_respond` and `sync_pairing_complete` both went, `sync_pairing_poll` arrived, a net
**−1**. Then the cover work deleted `deck_set_cover_image`, another −1. 157 → 156 → **155**, with
`sync_pair/pairing` now **nine** rather than ten, and not one of those three steps was an
arithmetic mistake by anybody.

**That is exactly the failure the census script exists for, and it is worth being precise about
which failure it is.** A hand-written total is not usually wrong when it is written — it is
wrong two merges later, in a repository where eight branches are open and a prose-only edit
routes to neither CI job. The lesson is not "run the command before quoting it", which this
author did; it is **do not paste a total into prose at all** when `--check` can assert it and a
reader can re-derive it in one command.

### Both risks were measured against the live endpoint rather than assumed

- **CORS: fine.** `GET https://api.github.com/repos/Msgaihede/mtg-grimoire/releases?per_page=30`
  with an `Origin:` header answers `200` and `Access-Control-Allow-Origin: *` (2026-08-31).
- **The two request headers preflight, and the preflight is answered.** `Accept` is
  CORS-safelisted; `X-GitHub-Api-Version` is not, so the request is preflighted. `OPTIONS`
  answers **204** with `access-control-allow-headers` naming `X-GitHub-Api-Version` and
  `access-control-max-age: 86400`, and carries **no `X-RateLimit-*` of its own** — one extra
  round trip a day against a check that is throttled to one a day. Both headers are sent, the
  same two the desktop sends.
- **`User-Agent` is the one that could have been fatal, and is not.** GitHub refuses a request
  that carries none: `curl -H "User-Agent:"` answers **403**, body *"Request forbidden by
  administrative rules. Please make sure your request has a User-Agent header"*. `fetch`
  forbids setting that header, so `web::net` cannot send the app-identifying string
  `scryfall::USER_AGENT` the desktop's `reqwest::Client` carries — **but the browser sends its
  own**, and a request with a browser UA and no other header answers `200`. So the check works
  and the UA is Chrome's rather than ours, which is the same trade `web/net.rs`'s header
  already records for Scryfall. No proxy, and nothing to work around.

### The seam: everything after the bytes is one copy

`update.rs` is still two thirds gated where it stands — `Updater`, `BusyGuard`, `Staged`, the
download-verify-stage half, the swap, the relaunch. What came out from under the gate is the
half that has nothing to do with an `.exe`:

| Now portable | What it is |
| --- | --- |
| `releases_url(api_base)` | The one URL, `per_page` included |
| `classify_status(code)` | `404` → `PageStatus::Missing`, `403`/`429` → the rate-limit sentence, non-2xx → `GitHub answered {code}` |
| `page_from_body(body)` | Parse, then drop drafts and prereleases |
| `record_check(conn, now, page)` | The three `app_meta` writes, empty page included |
| `last_check_at(conn)` | The throttle's stamp, `None` for anything unreadable |
| `parse_release`, `parse_release_page`, `latest_of`, `clear_app_meta`, `HISTORY_PER_PAGE` | Reached by the five above |

`check_inner` and `glue::update_check` are both a fetch plus those five in order. **What is
deliberately not shared** is the `Updater`'s `busy` flag — a process-wide claim over a download
this target cannot make — and `note_github`'s `error_log` row: a browser's check is always a
button press whose failure rejects the promise the panel is already watching, which is PR 11's
rule for the three feeds. The desktop needs the log because *its* check also runs unattended at
startup with no window listening.

**`SystemTime::now()` for the fifth time, and it did not bite.** `update::unix_now` stays
gated; `glue::update_check` reads `now_seconds`, which is `SELECT unixepoch()` off the
connection — the answer `tags`, `combos` and `marketplace_feed` each arrived at after a latent
Worker crash. The throttle is honoured here exactly as on the desktop, and `force` is what the
Check now button sends.

### Android already had the command, and only the UI was in the way

**`desktop.rs` is gated `#[cfg(not(target_family = "wasm"))]`, which is desktop *and* mobile**
— its own header says so — so `update_check` has been in the `invoke_handler` on Android all
along, with a working `reqwest` behind it. What is `#[cfg(desktop)]` is the *startup* check
spawned in `setup`, and that stays: on a phone the store is what notices a release, and a
launch-time request would spend one out of sixty an hour on something nobody pressed.

So the Android half of this work is entirely `UpdatePanel`, and it is one flag split into two:

- `selfUpdating` — can this build replace itself? Governs Download / Restart to finish / the
  release page, and nothing else now.
- `canCheck` — `status !== null`. Governs the Check now button and the version history.

Reading one flag for both questions is what drew a Download button over a page that can
download nothing (PR #315). Splitting it is what lets a phone read a changelog.

**Two smaller decisions in the same file.** The `elsewhere` sentence lost its tail *"and there
is nothing to check for here"*, which is no longer true. And **"Checking for updates…" is now
drawn only where something really is checking** — a desktop's startup check, or the first
frame on any target while `status` is still `null`. A browser that has never asked is told
nothing at all there: the `elsewhere` sentence points at the button, and `VersionHistory`
already says *"No releases have been read yet. Check for updates to fetch them."*

### What the mutations found

**Twenty mutations, twelve in Rust and eight in TypeScript, and every one was caught** —
after one round. None touched a path, a directory, or anything reachable by a delete: every
Rust mutation is inside a pure decision or an `app_meta` write, and the staging/swap half was
excluded outright.

**One survived on the first pass and is worth the round on its own.** `check_inner` propagates
a failed `app_meta` write for a real page and swallows it for a 404 — an asymmetry that has
been in that arm since it was written and had **no test at all**: collapsing it to swallow
everything left every test in the module green. It matters because a page that arrived and
could not be recorded hands the caller a `status` built from rows that are not the ones the
page described, and re-asks on every launch because the stamp never landed.
`a_page_that_cannot_be_recorded_is_an_error_and_a_missing_repository_is_not` drops the
`app_meta` table and drives both codes; both directions of the mutation now fail.

**A gate that could not fail, found the same way.** `scripts/build-wasm.mjs` greps the
generated glue for every export the Worker imports — the check that catches a deleted
`#[wasm_bindgen]` attribute, which the compiler cannot. Adding an export without adding it to
`EXPORTS` leaves that gate silently one short, so `update_check` is on the list.

**And one seam added for a mutation rather than for a test.** `db.ts`'s `runUpdateCheck` is a
one-line passthrough, exported for `runFeed`'s reason: what a single-export handler can still
get wrong is dropping the `force`, and a Check now button that answers instantly with
yesterday's page for a day at a time does not look like a bug from any angle.

### Not verified

- **Nobody has pressed the button in a browser or on the phone.** `glue.rs` is compiled only
  for wasm and is covered by nothing — the standing note above about the three feed ingests —
  so the coverage here is the five portable functions plus the TypeScript divert, and the wasm
  entry point is the thin call sequence over them. `npm run build:wasm` emits every export on
  its list, `update_check` included.
- **The 403/429 arm has never been seen from a browser.** It is the same code path the desktop
  tests against `httpmock`, and 60 requests an hour is not a budget a manual pass can exhaust.
