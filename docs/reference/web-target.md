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
- **Seventeen commands of 152**, as of 2026-08-29. The first four are the browse —
  `sync_status`, `search_cards`, `list_sets`, `facet_cards` — which is the read path spec §8
  wanted measured in wasm rather than guessed. The other thirteen are the Decks destination's
  reads (PR 10b). Adding one, once its module is in the map, is a line in
  `web::route::COMMANDS` and a `match` arm.

  ⚠️ **This is not the intended end state.** Decided 2026-08-29, after the phone layout made
  the boundary visible: **all of them but ten**, by destination, worst broken first. The survey,
  the ten that stay desktop-only and the reason each is a different feature rather than a port are
  at the foot of this file.

## The module map

`src-tauri/src/lib.rs` is the map and the split in it is binding.

| Compiled for wasm | Desktop/Android only |
| --- | --- |
| `app_meta` · `card_row` · `collection` · `collection_alloc` · `collection_folders` · `collection_source` · `combos` · `db` · `deck` · `deck_audit` · `deck_meta` · `deck_theory` · `deck_undo` · `errors` · `feed` · `filters` · `image_uri` · `index` · `ingest` · `legalities` · `maintenance` · `marketplace` · `schema` · `search` · `slug` · `sorting` · `split` · `sync` · `sync_engine` · `sync_pair` · `web` · `wishlist` · `wishlist_folders` | `card` · `export` · `flatten` · `images` · `import` · `listview` · `marketplace_feed` · `mirror` · `nav` · `paths` · `picked` · `reconcile` · `reset` · `scryfall` · `tags` · `transfer` · `update` · `window` · `zoom` |

**Eleven modules moved left on 2026-08-29** (PR 10a) — the deck domain, the collection, the
wishlist, both folder tables and `marketplace`. Nothing in them changed: they were on the right
because each file *ends* in a block of `#[tauri::command]` wrappers, and the gate sat on the
module instead of on the wrappers. See the PR 10a section at the foot of this file.

**Four of the exclusions are permanent** (spec §6.3): the plain-text `mirror`, the Rust
`transfer` writer that exists only for it, the portable `update` swap, and `window`'s Win32
snap layouts. The rest are "not yet" — they arrive with the commands that need them. `images`
is neither: on web the image cache is Cache Storage rather than a filesystem, so it is a
rewrite and not a port.

**A module's column is a fact about its contents; being *routed* is a separate question.**
Everything on the left compiles for the target. What the browser can actually call is
`web::route::COMMANDS`, which is 17 of 152.

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
| Tagger | ❌ | `tag_children` |
| Decks | ❌ *(reads routed 2026-08-29 — see PR 10b below; not yet driven on the device)* | `deck_folder_list`, `deck_list` |
| Collection | ❌ | `collection_list` |
| Wishlist | ❌ | `wishlist_list` |
| Settings | ❌ | `update_history`, `tags_muted`, `error_log_list` |
| The card pane, from Search | ❌ | `card_detail` — *"Could not read this card — unknown command `card_detail`"* |

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

- **`mirror/settings.rs`, 5.** The plain-text mirror writes a folder on disk *for other programs to
  read*. In OPFS nothing else can read it, so a web mirror would be the feature's name without the
  feature. `transfer` exists only to serve it and carries no commands of its own.
- **`desktop.rs`'s updater, 5** — `update_check`, `update_download`, `update_apply`,
  `update_history`, `update_open_release_page`. The portable updater swaps an `.exe`. **A PWA
  already updates through its service worker**, which ships and works; routing these would be a
  second answer to a question already answered.

On web those ten are hidden rather than broken, through the seam `SettingsPage` already uses to
hide the Backup panel on Android.

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
- **Covers.** `deck.rs` calls `images::{cover_file, write_cover, remove_cover, copy_cover}`,
  every one reached through a `covers: Option<&Path>` that is `None` on web. Gated rather than
  stubbed — a `write_cover` that silently did nothing would be a cover that looks saved and is
  not. `copy_cover_file` was restructured into a two-arm `copied_cover` helper, which retired an
  `.expect("a copy cannot have happened without a directory")` by putting that argument in the
  return type instead of in a panic message.
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

**`deck_set_cover_image` is the eleventh name on §6.3's desktop-only list**, and it is not
"not yet": it writes a file into a covers directory, and `deck::set_cover_image` does not
compile for wasm at all. Every *other* covers-touching command routes, because `delete_deck`
and `duplicate_deck` take `covers: Option<&Path>` and web passes `None` — the answer that
parameter was shaped for.

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

**Three families are not that shape** and need a browser mechanism that does not exist yet:
`import`/`export`'s file handles (spec §6.2 already specifies `<input type=file>` and a `Blob`
download), and `reset`'s OPFS deletion.

**The order is by destination, worst broken first** — Decks, then Collection, Wishlist, the card
pane, Tagger, Settings — so that every PR makes one nav destination genuinely work and can be
driven on the phone. It front-loads the deck domain, which is the biggest cluster and where the
surprises will be, and that is deliberate.
