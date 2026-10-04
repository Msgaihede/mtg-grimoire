# grimoire-web — the light app's web host

`grimoire-core` compiled to WASM and loaded by one dedicated Worker, with the page talking to it
through the `Core` seam (the light-app spec §6; phase 5, step 5.1, 2026-10-04). The cargo
workspace's fourth member. **It holds almost nothing of its own** — three exports, the OPFS pool
the two databases live in, and the state — and everything else is the core's. What was built and
measured is [light-app.md](../../docs/reference/light-app.md) §9; the engine's own rules are
[`crates/grimoire-core/CLAUDE.md`](../grimoire-core/CLAUDE.md), and they bind here.

## The exported contract

| Export | Takes | Answers |
| --- | --- | --- |
| `open(directory)` | The OPFS directory's name — a bare name, not a path | JSON text: `{"kind":"ready","journal":…,"corpusJournal":…,"schemaVersion":…}`, `{"kind":"already-open"}` or `{"kind":"failed","message":"…"}` |
| `call(name, args, body?)` | A command's desktop name, its arguments as JSON text (`"null"` for none), an optional byte body | JSON text: `{"ok": <value>}` or `{"err": "<sentence>"}` |
| `listen(handler)` | One function, `(name, payload)` with the payload as JSON text | Nothing. A second call replaces the first handler |

- **It is the wire the Worker's hand-written `.d.ts` mirrors** —
  `src/lib/core/web/grimoire_web.d.ts`, with `protocol.ts` reading the two JSON shapes.
  `dist-wasm/` is ignored, so the declarations `wasm-bindgen` writes are on no machine that has
  not built the module, and nothing generates the mirror: **a change to an export, or to a
  string in `wire.rs`, is a change to those two files in the same commit.** `wire.rs`'s tests pin
  the strings on this side and `protocol.test.ts` on that one; neither reads the other's.
- **`scripts/build-wasm.mjs` lists the three names too** (`EXPORTS`) and fails a build that does
  not export one — a missing `#[wasm_bindgen]` attribute compiles with no error and no warning.
- **`call` is `grimoire_core::dispatch` and nothing else**, so a command the core's table does
  not have is refused here in the table's own words. A command joins the web app by joining
  `crates/grimoire-core/src/commands.rs`, never by an arm in this crate.

## Nothing here may trap or reject

**A trap in a Worker does not arrive as a rejected promise with a message.** It arrives in the
Worker's `onerror` with nothing a page can show, and round one sat at "running…" for a whole
run over one. So every way an export can go wrong is an *answer*:

- A `call` before `open` has answered `ready`, arguments that are not JSON, a name the table
  lacks, a raw body where none belongs — each is `{"err": "…"}` (`host::call`,
  `every_wrong_call_is_an_err_and_names_the_command`).
- A storage install that fails is `already-open` or `failed`, told apart by the
  `DOMException`'s **name** (`NoModificationAllowedError`) anywhere in the text — the wording
  has changed between Chrome versions, and `sqlite-wasm-vfs` wraps a variant of its own around
  it. Everything else is a real failure and says so, rather than telling a reader to close a
  tab that is not open. **`already-open` says a Worker of this origin holds the pool, not that
  a tab is open** (step 5.5b): a Worker inside a long synchronous call outlives its document
  by one to three seconds, measured in Chrome 154. The page tells the two apart by a Web Lock
  and retries with a fresh Worker when the lock is its own
  ([`mobile/CLAUDE.md`](../../mobile/CLAUDE.md), `src/lib/core/web/holder.ts`); this crate
  still opens once and never retries.
- An answer that will not serialise is still a parseable `{"err": …}` (`wire::text`).
- The panic hook is installed as the module is instantiated, so a bug that does trap leaves its
  sentence and its line in the Worker's console first. **The core's own `eprintln!` goes
  nowhere on this target**; `console.warn` is declared in `glue.rs` for what must not be silent.
- **The launch's downloads are a task on this same thread**, so a trap inside one is a trap
  in the Worker like any other — and **a lock they held across an `.await` would be one**:
  every `call` taken during a download takes the connection, and std's `Mutex` panics on a
  second lock where there are no threads. The core's streamed downloads hold none; its tests
  run them on one connection and one thread to prove it. **A `call` is taken during a
  download only because the download gives the event loop a turn** — every 50 ms of work
  (`grimoire_core::platform::timer::yield_to_host`): an `.await` on a chunk the network has
  already buffered is a microtask, and the Worker's `message` is a task. Without that turn
  the first measured run answered a page's `sync_status` 3.5–8.4 s late. **The tag files'
  finish and the combos' store take the same turn between their batches** (step 5.3) — a
  `call` taken there is answered from the previous tags or combos — and the card finish,
  each swap and the price list's store still answer nothing until they end. **Timed once
  in a browser** (headless Chrome 154, 2026-10-04, light-app.md §9.3): a `sync_status`
  sent once a second waited at most 53 ms inside the oracle tags' finish, 1.10 s inside
  the art tags' and 0.81 s inside the combos', and 4.79 s across the card finish — the
  longest single wait of that first run, where it had been 23.57 s and 26.1 s.
- **No `RefCell` borrow is held across an `.await`**: `call` clones the state's `Arc` out of
  its `thread_local` first. A borrow held there is a `BorrowMutError` the first time a call
  arrives while another is in flight — and that is a trap.
- **A lock taken twice is a trap here too.** std's `Mutex` panics on a recursive lock where
  there are no threads, and this host has one connection, so a read asked for while the same
  thread holds the write connection is exactly that. The fence is the core's:
  `commands::tests::every_command_answers_on_one_connection_and_one_thread`.

## `open` happens once

`open` installs a pool of exclusive file handles and builds the state; done twice it would
install a second pool and replace the state under every call in flight. **`host::Once` keeps
the first call's future and every later caller awaits a clone of it** — one install, one state,
the same answer for all of them, a failure included. A page that wants another attempt reloads,
which is a new Worker. The Worker's script memoises the *load* for the neighbouring reason: two
instances of a `wasm-bindgen` module in one Worker corrupt each other's heap.

**One instance per Worker, and it must be a dedicated Worker**: the pool's access handles
exist only off the main thread. Cross-origin isolation is **not** required — round one served
the page with and without `COOP`/`COEP` and passed both ways. Do not add those headers for this.

## What is gated, and what is not

| Module | Compiled for | Holds |
| --- | --- | --- |
| `wire` | every target | The JSON each export answers, and the one-tab guard's string match |
| `host` | every target | What the exports decide: `start` and `start_replacing`, which of a pool's files are the corpus's and how they are deleted, what a launch downloads and in what order, a call's refusals, `Once`, the pool's name and capacity |
| `glue` | `wasm32` only | The `#[wasm_bindgen]` shell, the pool's install, three `thread_local`s |

- **Only `glue.rs` is target-gated, and a decision never goes in it.** A module gated to the
  browser is invisible to `cargo test`, and a typo in a wire string there is a silent
  `undefined` in a page. Whatever an export decides takes what a browser would have handed it
  as an argument — `host::start` takes the databases' place, so a scratch directory stands in
  for the pool — and is tested natively.
- **So `cargo test -p grimoire-web`, `cargo clippy --workspace` and `cargo fmt -p grimoire-web`
  all reach the crate on a desktop** — and none of them compiles `glue.rs`. It is built by
  `npm run web:wasm` and by CI's `web` job, and **linted by that job alone** — `cargo clippy
  --lib -p grimoire-web` for wasm32, ahead of the build; `core`'s wasm clippy names
  `grimoire-core` alone. Nothing in `npm run verify` reaches it, so lint it by hand when you
  change it (below).
- **Compiling is not running.** The native tests run this crate's decisions on a thread
  standing in for a Worker (`grimoire_core::platform::alone`); the module itself is run by
  `web:smoke`, in a browser, and by nothing on a desktop.

## The manifest

- **Never `grimoire-core`'s `testing` feature on the `[dependencies]` line** — it is on
  `[dev-dependencies]` only. Two things behind that feature are not scaffolding (the core's
  `CLAUDE.md` names them): in a shipped module they would be an image fetcher that accepts a
  loopback host and an undo that finds nothing. `platform::fence` reads this manifest for it,
  and CI's `rust` job asks `cargo tree` the same of this package by name.
- **The version is the app's.** The three hosts ship from one tag and one core is one schema
  version; release-please bumps this manifest and its `Cargo.lock` entry with the others
  (`release-please-config.json`), and `host::tests::the_host_wears_the_cores_version` goes red
  when it and the core's part. Never type it.
- **The `wasm-bindgen` CLI must be exactly the version `Cargo.lock` resolves for the crate.**
  `scripts/build-wasm.mjs` reads the lockfile and refuses to build otherwise, and CI's `web` job
  installs the CLI at the version it reads from the same file. Moving the crate's version is
  moving the CLI with it, on every machine that builds.
- **`rusqlite` here is the core's WASM line** — `hooks`, and ⚠️ never `default-features =
  false`, which switches off the backend that makes SQLite build for a browser at all.
- **`httpmock` and `flate2` are `[dev-dependencies]`**, at the core's versions: the launch's
  downloads are driven against a local mock Scryfall, never the real one. ⚠️ A test of
  `launch_downloads` must stamp `combo_meta` as just checked, as that one does — the combo
  feed's address is a constant, and a due one would ask Commander Spellbook.
- **A new workspace member's chores were all done for this one, and are the list for the
  next**: a `-p` on the `cargo fmt` line in `ci.yml` and in `lint:rust`, a manifest and a
  lockfile entry in `release-please-config.json`, its package name in the `rust` job's
  `testing` check, and an arm in `scripts/ci-route.mjs`.

## What the host starts, and what it deliberately does not

`host::start_replacing` opens the pair on one connection
(`grimoire_core::launch::open_single_replacing`), builds a `State` with no read connection and
no write observers, and builds the facet index. `glue`'s `open` then spawns
`host::launch_downloads` and answers without waiting for it (step 5.2, 2026-10-04).

- **The launch's downloads, as one task on the Worker's own event loop**
  (`wasm_bindgen_futures::spawn_local`), **one after another**: the card sync when it is due,
  then the selected marketplace's price list, the oracle tags, the art tags and the combos,
  each when it is due. **Always the cards first** — issue #551's rule for a first run, and
  here for every later launch too, where a host with threads runs the feeds beside the card
  sync and all four at once. A Worker is one thread, which changes three things: two ingests
  at once gain nothing but overlap on the network; its memory is the module's linear memory,
  which grows and is never given back, so together the session's high-water mark is a sum
  rather than the largest; and **a download waiting on its next chunk is waiting on a timer
  that counts through whatever else the thread does** — beside a card sync's swap, reclaim
  and index build, a feed's stall bound would be timing that tail and not its connection.
  Each is still its own run with its own claim and its own stall bound, so none can stop the
  next. ⚠️ It costs the feeds a wait behind a slow card sync. Chosen by reasoning, not by
  comparison: a browser has run this arrangement (all launch feeds done 76 s after
  navigation, light-app.md §9.2 — and 50.84 s on the one run since the tag and combo
  finishes take turns, §9.3) and never the other.
- **How a download works here is the core's**: no temp file, a body streamed into its sink,
  no conditional header, a stall bound on every wait
  ([`crates/grimoire-core/CLAUDE.md`](../grimoire-core/CLAUDE.md), *A download has two
  shapes*). Nothing in this crate knows a URL. **What to start, and in what order, is
  `host.rs`'s** — `a_launch_downloads_the_cards_and_then_each_feed_in_turn_on_every_launch`
  runs it natively against a mock Scryfall — and `glue.rs` only spawns it.
- **It runs once per launch and ends.** Not an upkeep loop: a feed that was not due is not
  looked at again until the next launch, or until a page presses its Refresh.
- **No image upkeep loop.** `images::upkeep_tick` evicts files this host does not have, and a
  Worker has no thread to sleep on.
- **No picture is fetched here either.** A page's picture requests are its service worker's,
  kept in Cache Storage; what the engine answers is *where a picture is* — the table's
  `card_image_source`, through `call` like any command: a path in, and
  `{"kind":"uri","uri":…}`, `{"kind":"missing","svg":…}` or `{"kind":"unknown"}` out. The
  desktop has no such command (`src-tauri`'s `command_table::TABLE_ONLY`). **A browser has
  asked it** (the same run): all 105 picture requests the page made were answered 200 by
  the service worker — 24 uncached pictures among them asked inside the art tags' finish
  — so no `unknown` was answered there. A back face was not reached against the real
  hosts; the smoke run's fixtures reach a transform card's.
- **A corpus that will not open, or will not migrate, is thrown away and built again** — the
  desktop's "replace it and resync", through the pool's own delete. `install_pool` keeps the
  pool's management handle for the length of `open`; the closure `glue` hands
  `host::start_replacing` is `host::delete_corpus(&pool.list(), …)` over the pool's
  `delete_db`. **`host::corpus_files` puts the journal before the database, and
  `delete_corpus` attempts every file whatever an earlier one answered** and reports the first
  failure — so a delete that goes half way leaves an old database with nothing beside it,
  which the next launch throws away again, never an old journal beside a new corpus.
  **Which failures delete a corpus, that it is tried once, and that `user.db` is never
  touched are the core's to decide** and are tested there and here natively; the console is
  told (`host::CORPUS_REPLACED`), and the page finds no cards, which reads as a first run
  that the launch's card sync then fills. ⚠️ **The pool's `delete_db` has run in no
  browser**: the native tests stand a closure in for it, and what the pool names its files
  (`pool.list()`) has been read in the crate's source and not seen.
- **A facet index that could not be built is a `console.warn`, never a failed `open`**:
  faceting fails open by design.
- **The pool's capacity is 64 files, not bytes** (`host::POOL_CAPACITY`) — two databases, a
  rollback journal each, and one more for each temporary b-tree while it lives, because the
  one-connection opener sets `temp_store = FILE`. It is round one's figure and nobody has
  justified it by measurement; a smaller one is an experiment to run on purpose, with an ingest.

## Building and running it

| | |
| --- | --- |
| `cargo test -p grimoire-web` | The crate's decisions, natively |
| `npm run web:wasm` | The module into `dist-wasm/`: `cargo build -p grimoire-web --lib --target wasm32-unknown-unknown --profile wasm --locked`, then `wasm-bindgen --target web`. Prints the module's size and the build's time. `-- --names` keeps the function names, for a readable wasm stack |
| `npm run web:dev` | The dev server on port 5176, over whatever `dist-wasm/` holds at that moment |
| `npm run web:build` | `tsc`, the Worker's and the service worker's `tsc` programs, and the page into `dist-web/` with the engine under `wasm/<build id>/` and, last, `sw.js` at its root |
| `npm run web:smoke` | The built app in headless Chromium, as an offline first run: every request the engine and the service worker make is answered from `scripts/web-smoke/` or fails the run. The module instantiates, the database opens on a rollback journal, the card sync and the launch's feeds finish, a typed search draws a card and its picture, Settings greys Mana Pool and downloads Card Kingdom, a reload with the server gone still holds the cards and draws the cached picture, a second tab is refused, a newer worker waits for the press, and a deck note opens and takes typing with no style element put on the page. **Served under the hosting's `_headers` since step 5.5b**: a Content-Security-Policy refusal in the page, this Worker or the service worker fails the run |
| `npm run web:preview` | The built app on port 4176, with its service worker — the one of these that draws card pictures besides the smoke run; `web:dev` registers no worker |

- **`web:wasm` finds clang by itself on this machine** — `C:\Program Files\LLVM\bin`, which is
  not on `PATH` — and refuses a clang older than 18. **A bare `cargo` for the target does not**,
  and `cc-rs` does not look either:

  ```bash
  CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe" AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe" cargo clippy -p grimoire-web --lib --target wasm32-unknown-unknown --locked -- -D warnings
  ```

  That is CI's `core` clippy line with this package's name in it, and it is the only lint
  `glue.rs` gets — by hand, because no job runs it.
- **The profile is `wasm`, in the root `Cargo.toml`**: it inherits `release` and adds fat LTO,
  one codegen unit and `panic = "abort"`. **`[profile.release]` is deliberately not written
  there** — a change to it for the browser's sake would change the binaries people have
  installed. No `wasm-opt` and no `wasm-pack`; neither is on the machines that build this.
- **The module is the core, and what is in it was read off its name section** (2026-10-04,
  step 5.5, at `opt-level` 3): of 5 992 636 B of code, `grimoire_core` is 58 % — the command
  table and its JSON alone 915 659 B, the sync engine 586 598 B — and SQLite's C 22 %. The
  scanner's pipeline, which no browser can run before phase 7, is not in it: LTO drops what no
  export reaches, and 35 583 B of the scanner's tray and preferences is what stays. The OCR
  runtime that step 5.1 found rooted by `ocrs`'s `export-wasm` feature, 1 882 984 B, went with
  one line in `crates/card-scanner/Cargo.toml`. The root `Cargo.toml`'s `wasm` profile has the
  sizes at each `opt-level`. **`opt-level` stays 3, by timings**: `"s"` was 2.35 s slower on a
  first run's card phase and `"z"` 7.01 s, in headless Chrome 154 (light-app.md §9.6, with what
  that does not prove); the module that shipped is 6 767 338 B, 2 372 783 B through `gzip -9`.
  **The glue's exports are the check nothing else makes**: `open`,
  `call`, `listen`, the start function `instantiated`, and `reqwest`'s three `IntoUnderlying*`
  classes — any other class in `dist-wasm/grimoire_web.js` is some dependency's
  `#[wasm_bindgen]` API, and a root that keeps its whole crate.
- **Never `cargo fmt --all`** — it follows path dependencies into `crates/card-scanner`, which
  is hand-formatted. `cargo fmt -p grimoire-web`.
- **A green suite here proves a desktop.** Every figure taken in a browser names the browser
  and the build beside it.
