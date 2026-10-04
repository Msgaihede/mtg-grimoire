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
  tab that is not open.
- An answer that will not serialise is still a parseable `{"err": …}` (`wire::text`).
- The panic hook is installed as the module is instantiated, so a bug that does trap leaves its
  sentence and its line in the Worker's console first. **The core's own `eprintln!` goes
  nowhere on this target**; `console.warn` is declared in `glue.rs` for what must not be silent.
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
| `host` | every target | What the exports decide: `start`, a call's refusals, `Once`, the pool's name and capacity |
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
- **A new workspace member's chores were all done for this one, and are the list for the
  next**: a `-p` on the `cargo fmt` line in `ci.yml` and in `lint:rust`, a manifest and a
  lockfile entry in `release-please-config.json`, its package name in the `rust` job's
  `testing` check, and an arm in `scripts/ci-route.mjs`.

## What the host deliberately does not start

`host::start` opens the pair on one connection (`grimoire_core::launch::open_single`), builds a
`State` with no read connection and no write observers, builds the facet index, and stops.

- **No download** — no card sync, no feed. A download in a browser has no temp file to land in
  (`platform::files` refuses there), and what it looks like instead is step 5.2's. Until then a
  web install has no cards.
- **No image upkeep loop.** `images::upkeep_tick` evicts files this host does not have, and a
  Worker has no thread to sleep on.
- **Nothing replaces a corpus that will not open.** `launch`'s `unreadable_corpus_seam` is
  where that is written down. The pool's management handle — where a later step finds
  `delete_db` — is let go by `install_pool` today; asking `install` again for a registered VFS
  answers the handle and installs nothing.
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
| `npm run web:build` | `tsc`, the Worker's `tsc` program, and the page into `dist-web/` with the engine under `wasm/<build id>/` |
| `npm run web:smoke` | The built app in headless Chromium: the module instantiates, the database opens on a rollback journal, a read comes back, a reload reopens it, a second tab is refused |
| `npm run web:preview` | The built app on port 4176 |

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
- **The module is large and the reason is known**: measured 2026-10-04, 8 547 708 B, about
  1.84 MB of it an OCR runtime nothing calls. The root `Cargo.toml` and the core's `CLAUDE.md`
  carry the measurement and the cure, which is `crates/card-scanner`'s line to change; it and a
  size-optimised level are step 5.5's, with timings.
- **Never `cargo fmt --all`** — it follows path dependencies into `crates/card-scanner`, which
  is hand-formatted. `cargo fmt -p grimoire-web`.
- **A green suite here proves a desktop.** Every figure taken in a browser names the browser
  and the build beside it.
