# grimoire-core — the engine with no window

What every host links: the desktop app in `src-tauri` today, an Android shell and a WASM build in
a Worker later. The design is
[the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md)
§2; what each extraction step built and measured is in
[light-app.md](../../docs/reference/light-app.md).

**It is being filled a step at a time, and since 2026-10-02 most of the engine is here.** What is
here is what `src/lib.rs` declares: the leaves; the storage layer — `db`, `schema` with both
ladders, `sync_meta`, `filters`, `sorting`, `card_row`, `image_uri`, `errors`, `feed::backoff` and
`sync_engine::capture`; the state a host holds over it — `state`, `hooks` and `events`; and the
**domain** — the decks, the collection, the wishlist, the search, the card pane, the view-state
modules, `maintenance`, and the sync engine's `apply` and `baseline`: forty-nine modules, moved in
one pass by `scripts/core-step-4.mjs`. **What is not here reaches a network, a filesystem or the
relay**: `scryfall`, `ingest`, the three feeds (`combos`, `marketplace_feed`, `tags/`), `images`,
`index/`'s facets and lifecycle, `reconcile`, `sync` (the card sync), the sync client and pairing,
`share/` and the scanner. Every rule in [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) about a
module binds that module wherever it lives — moving a file changes which crate compiles it and
nothing about what it must do. **That file's database and deck rules are this crate's now**: a
schema rung, a grain, a capture spec, a deck write is edited here.

## A command wrapper is not here, and never will be

**Nothing in this crate is a `#[tauri::command]`.** A wrapper names a window, the desktop's
`AppState` and a thread to run on, so each one stayed in `src-tauri`, in a module of the same
name: `src-tauri/src/deck/mod.rs` is `pub use grimoire_core::deck::*;` and, below it, deck's
wrappers. An item a module defines shadows a glob import of the same name, so `crate::deck::…`
over there is this crate's item unless that file defines one.

- **A new command is written in `src-tauri/src/<module>/mod.rs`; the function it calls is
  written here**, `&Connection` in and a DTO out, and is `pub` — a `pub(crate)` item does not
  cross the glob. Forty-six modules have such a file; `managed_wishlist` and the sync engine's
  `apply` and `baseline` have none, because nothing of theirs stayed.
- **A module's own `//!` doc may still say its wrappers are "in one block at the foot".** They are
  at the foot of `src-tauri`'s file. The docs moved with the code, unedited.
- **`ipc.test.ts` reads such a module as both halves**, joined under the name its assertions
  already used (`deckRs = deckRsCore + deckRsDesktop`). A new `?raw` import of a moved module
  owes both files.
- **It was meant to be a `commands/` folder** (spec §2.3). Markus chose this shape instead on
  2026-10-02: 245 of `generate_handler!`'s 257 entries are a path through a module and none had to change. The folder
  can be a rename later, with the command table.

## Four rules, and what goes red for each

| Rule | Held by |
| --- | --- |
| **No `tauri` dependency** — not the crate, not its build script's, not a plugin, not `wry` or `tao`, not under another name | `platform::fence`, which reads `Cargo.toml` |
| **`cfg(target_…)`, `cfg(windows)` and `cfg(unix)` appear only under `src/platform/`** | `platform::fence`, which reads every source file |
| **Nothing outside `src/platform/` names `SystemTime`, `UNIX_EPOCH` or `std::time::Instant`** — reading any of them panics on `wasm32-unknown-unknown`, at run time, in a build that compiled clean | The same sweep |
| **It compiles for `x86_64-pc-windows-msvc`, `aarch64-linux-android` and `wasm32-unknown-unknown`** | CI: the `core` job for the last two, the `rust` job for the desktop, where the tests run |

- **The fence reads code lines and skips comment lines**, so prose may name what it refuses. A
  line is a comment only when it *starts* with `//`: a trailing comment and a `/* … */` block
  are read as code.
- **It sweeps test code too.** A test never compiles for a browser, but the sweep does not
  parse `#[cfg(test)]`, so a clock read in a test is refused like any other. Take the time from
  `platform::clock` — `Tick::now()` and `elapsed()` are what a test that times something uses,
  as `db`'s do — or from SQLite.
- **It is a text sweep, and three things pass it**: a clock reached through a re-export or
  another crate's `now()`, a gate inside a macro this crate does not define, and a host that
  arrives as somebody else's dependency. The first two fail the `core` job or a browser; the
  third is what `cargo tree -p grimoire-core -i tauri` answers.
- **A target key is refused anywhere on a code line**, so an identifier that contains one
  (`target_os_name`) is refused too. Rename it.
- **Do not weaken the fence to make it pass.** A module that needs to know its machine gets an
  interface under `platform/` with one implementation per kind of host.

## `platform/`

| | Native | Browser |
| --- | --- | --- |
| `platform::clock::now_ms`, `now_secs` | `SystemTime` | `Date.now()` |
| `platform::clock::Tick` — `now()`, `elapsed()`, for how long a wait has run | `Instant` | `Date.now()`, never negative |
| `platform::pause(Duration) -> bool` — stand aside for another thread | `thread::sleep`, `true` | **`false`, at once**: a Worker has no other thread to wait for |

`db::lock_for` and `db::lock_background` are why the last two exist. **A wait that polls is a wait
that cannot succeed in a browser**, so `lock_for` gives up on its first contended attempt there
and its caller answers `db::BUSY`. Neither browser arm has ever run — the crate compiles for
`wasm32` and nothing instantiates it.

HTTP, files, a sleep a future awaits and background work are named in `platform/mod.rs` with the
step that brings each — an interface is written with its first caller, not ahead of it.
(Background work was the state step's row and had no caller there: nothing in `state`, `hooks` or
`events` spawns anything. It is the I/O step's.)
**`schema` names `std::fs` directly** (the corpus it replaces, the backup before a climb, the
damage mark): that compiles for a browser and fails there when called, and waits for the I/O
step.

**Most of the engine never asks for the time.** The domain modules use SQLite's `unixepoch()`
and `date('now')` inside the statement that needs them, which is the same on every host.

## State, the hook and events

**A host builds one `state::State` and everything else is handed it.**
`State::new(write, read, data_dir, events, observers)` takes connections the host opened and
brought to head, installs the hooks on the write connection, and only then puts it behind its
mutex. So there is no `State` whose cross-file fence is not riding.

- **No shipped code installs a hook but `hooks::install`, and a host never calls it for its
  app's connection** — `State::new` has. SQLite keeps one update hook, one commit hook and one
  rollback hook per connection, and a second install **replaces** the first without a word:
  `hooks::tests::a_second_install_replaces_the_first`. Whatever needs to hear about a write is a
  `WriteObserver` in the list `State::new` is given. (Two of `src-tauri`'s tests put a raw hook
  on a bare connection of their own — `reconcile` and `tags` — and the desktop's
  `watch::install_hook` pair is `#[cfg(test)]`, so none of it can reach the app's.)
- **The fence is ahead of every observer, on both hooks.** On the commit hook that is pinned —
  `the_fence_has_settled_by_the_time_an_observer_hears_the_commit` — and on the update hook it
  is not, because the bits a row leaves are private and no observer can ask for them.
- **An observer runs inside SQLite's callback**, on the writer's thread with the write
  connection's mutex held: an atomic, a lookup in a list built beforehand, a notify that cannot
  block. Never a lock another thread holds for long, never a call back into the database.
- **Observers are told in list order, on both hooks, and the order is a contract.** The
  desktop's list is `mirror::watch::observers` — sync wake, change mask, mirror mask — which
  gives the update hook and the commit hook the call order each has always had.
- **The update hook has two blind spots, both pinned in `hooks`' tests**: a `WITHOUT ROWID`
  table never reaches `row`, and neither does a bare `DELETE` on a table with no triggers and no
  foreign key naming it. Both still reach `committed`. An observer that must not miss a write
  listens for the commit.
- **`read` is `None` on a host that can have only one connection** — a browser's storage
  permits exactly one (spec §6). `State::reader()` is then the write connection's own mutex, and
  `lock_db_read` takes it. ⚠️ **Nothing has run that way**: a read asked for while the same
  thread holds the write connection is a lock taken twice, which the desktop's two connections
  never notice. `reader()` is also what a caller passes on where it used to pass
  `&state.db_read`; the field is private.
- **`events::EventSink` is how an event leaves the crate, and nothing here emits yet.** A host
  gives the state one sink; code with something to say calls `events::emit`. Never an
  `AppHandle`, a window or a channel as a parameter. Its first callers arrive with the I/O step
  (`run_sync`, the feeds) and the sync step (live sync), which still emit through the desktop's
  window from `src-tauri`.

**`State` is the every-host half of the desktop's `AppState` as far as the extraction has got.**
`AppState` wraps it and derefs to it, so `state.db` over there is this struct's field. What
`AppState` still declares, and when each leaves:

| Field | Its type | Comes here with |
| --- | --- | --- |
| `syncing` | `AtomicBool`, `run_sync`'s flag | step 5 |
| `client` | `scryfall::Client` | step 5 |
| `images` | `images::Cache` | step 5 |
| `index` | `index::lifecycle::IndexSlot` | step 5 |
| `pairing` | `sync_pair::pairing::Pending` | step 6 |
| `mirror`, `mirror_status`, `changes` | the mirror's and the other windows' | never: the desktop's |

**`state::with_write` is the one definition of a user-facing write, and it is here since the
domain step.** `with_write`, `with_write_waiting` and the private `written` they share: the
managed wishlists armed, the caller's closure, the token reconcile, the settle, and the fence's
`debug_assert` — in that order, on both the bounded path and the waiting one. They are free
functions over `&State` rather than methods, so every caller in `src-tauri` reads as it did:
`sync` re-exports the two, and an `Arc<AppState>` passes as `&state` through the deref. The body
is byte for byte what it was but for the parameter's type. **It waited a step** because it has no
line to be cut at — the three calls sit between the lock and the assertion — and a write with no
settle would have been a second definition of a user-facing write.

- **A function here that writes takes `&Connection`, and its host wraps it in `with_write`.** Not
  the other way round: a core function that took the write lock itself could not be composed
  into a caller's transaction, and none does.
- `collection_source::with_write_owned` — `with_write` plus the facet index's `owned` rebuild —
  is still `src-tauri`'s, because the index's lifecycle is.

## Moving a module here

1. **Check its tests as well as its code.** A module whose own code is pure can still open
   `schema::memory_pair()` in its tests, and a module's tests move with it. That is what kept six
   of the spec's fifteen "leaves" out of the first step.
2. `git mv` the file, so its history follows.
3. In `src-tauri`, **`pub mod x;` becomes `pub use grimoire_core::x;`** at the same place in the
   module map. `crate::x::…` goes on resolving there, so no caller is edited and no open branch
   has to re-learn a path.
4. **`pub(crate)` stops reaching `src-tauri`.** An item the desktop still calls becomes `pub`.
5. **A file read by relative path is one directory further away** — `include_str!` of
   `relay/src/log.ts` from `src/sync_engine/` is four `..` here where it was three.
   `scripts/ci-route.test.mjs` derives which CI job each such read routes to.
6. **A dependency the module brings is declared here as `src-tauri` declares it** — same
   version, same features — and leaves that manifest if nothing there names it any more, with
   the comment that argued its version.
7. A doc link to a module still in `src-tauri` is left as it is. It resolves again when that
   module arrives.
8. **A function that names a later step's code stays behind, alone.** `src-tauri` keeps a module
   of the same name — **as `x/mod.rs`, never `x.rs`**, so the old path is gone and git records
   the moved file as a rename — that is `pub use grimoire_core::x::*;` plus that function — an item a module
   defines shadows a glob import of the same name, so every other `crate::x::…` there is this
   crate's. Cut where the function already draws a line, and prove the halves rejoin to the
   original body byte for byte. Never a callback the host passes in: the next step would delete
   it.
9. **A test that names a module still in `src-tauri` stays there, unedited**, beside the
   re-export. Everything else in the test module moves.
10. **Test scaffolding another crate's tests reach is gated
    `#[cfg(any(test, feature = "testing"))]`**, never plain `#[cfg(test)]` — a dependency's
    `cfg(test)` is off while another crate's tests build. Helpers both sides need go in a
    `pub mod fixtures` at the **foot** of the file, below `mod tests`: `scripts/coverage-rust.mjs`
    counts everything from the first column-0 `#[cfg(test)]` down as test code.
11. ⚠️ **Grep the module for `cfg!(test)` and `#[cfg(not(test))]` as well — a behaviour that
    switches on `test` goes dark without a compile error.** `image_uri` allowed a loopback host
    under `cfg!(test)`; moved, it refused, and ten of `src-tauri`'s `images` tests were served
    the placeholder. Rule 10's gate is the fix, and anything it widens is then something the
    `testing` feature ships if it leaks — say so beside it. `bulk_undo::with_store` was the
    second: its process-wide ticket store and its per-thread twin follow the feature since the
    domain step. Two `#[cfg(not(test))]` sites wait in modules that have not moved:
    `sync_engine/entitlement.rs` and `sync_engine/client.rs`.
12. **A `#[tauri::command]` wrapper stays, with everything that names the desktop** — `tauri::`,
    `AppState`, an `AppHandle` — and with any private helper only those items call. `src-tauri`
    keeps `x/mod.rs` as in rule 8, and its `lib.rs` line stays `pub mod x;`.
13. **A test that names something that stays, stays**, in the remainder's own `mod tests`. A
    helper both sides call is a fixture (rule 10); a helper only the staying tests call goes with
    them.
14. **Do it with the splitter, not by hand.** `scripts/lib/rs-items.mjs` cuts a file into its
    top-level items and rejoins it byte for byte, and `scripts/core-step-4.mjs` is rules 2 to 13
    applied to a list of modules: what stays, what moves, the imports each half still needs, the
    visibilities `src-tauri` still reaches, the fixtures. `--dry` prints the decisions without
    writing. The next step's script is that one with another list.

## What a moved module left in `src-tauri`

Each row goes home in the step that moves what it names.

**Beside every module's command wrappers**, which are not listed — `grep -c '#\[tauri::command'
src-tauri/src/<module>/mod.rs` counts them:

| Module | Still in `src-tauri` | Because it names | Home with |
| --- | --- | --- | --- |
| `schema` (`src/schema/mod.rs`) | `prepare_data_dir` — `split::convert`, then `schema::replace_unreadable_corpus` here | `split`, which only the desktop has | never: `split` stays |
| `schema` | 8 of its tests | `split`, through that function or a converted fixture; one, `tags::query` | never, and step 5 |
| `sync_engine::capture` | 2 of its tests, in `sync_engine/capture_tests.rs` | `reconcile` | step 5 |
| `errors` (`src/errors/mod.rs`) | `kind_of` and its test | `scryfall::ScryfallError` | step 5 |
| `deck` | `bracket_reads`, `DeckBracketRead`, their two SQL constants and 5 tests | `combos::match_combos` — `combos` is a feed | step 5 |
| `reset` | `clear_cache`, what only it calls, and 8 tests | `images::Cache`, the three feeds' `any_refresh_running` | step 5 |
| `collection_source` | `with_write_owned` | `index::lifecycle::invalidate_owned` | step 5 |
| `collection`, `deck_tokens`, `card`, `search` | 1, 2, 1 and 1 tests | `index::fixtures`, `sync_engine::client`, `images`, an `AppState` built whole | steps 5 and 6 |
| `maintenance` | 9 tests — nothing of its code | a database `split` converted | never |
| `import` | `read_import_file`, two helpers and 5 tests | a path the desktop's file dialog answered | never: a host reads its own file |
| `marketplace` | `set_marketplace_now` | `AppState.mirror` | never: the mirror is the desktop's |

**Three modules on the domain step's list did not move, and one function**: `reconcile` (its
`apply` takes `&[scryfall::Migration]`), `tags/` (`query` and `muted` take `tags::Dataset`, which
sits in the fetch engine) and `deck::bracket_reads`. The alternative was to hoist those three
small pieces into this crate ahead of their modules; Markus declined, as he had for the sync
client's cursor keys in step 2. They arrive with the I/O step.

**`schema::prepare_database` is the launch**: `bring_to_head`, then the logged passes — the FTS
rebuild an interrupted compaction owes, the staging table a killed ingest left, the trims, the
managed wishlists, the token conversion and repair, and last the drain of the dirty marks those
left. **`bring_to_head` is every step of it that may stop a launch**: `migrate_user`,
`migrate_corpus` (or the corpus replaced), then `capture::clear_stale_guard` and
`capture::install`. A host that opens a database calls `prepare_database`; `State::new` then
takes the connections.

⚠️ **A new user rung still owes its `UNDO_V<N>` in two files**: the constant goes in
`schema::fixtures` here, at the head of every chain in this file's tests — and at the head of
the one chain left in `src-tauri/src/schema/mod.rs`, `migrate_the_real_database_to_v29`'s, which
is `#[ignore]`d and so never goes red for it. (The v59 conversion test's chain came home.)

## The manifest

- **`rusqlite` is two lines**: `bundled` plus `hooks` everywhere but WASM, and `hooks` alone
  there. ⚠️ **Never `default-features = false` on the WASM line** — the backend that makes
  SQLite build for a browser is in rusqlite's default set, and switching it off fails with
  `unresolved import libsqlite3_sys`, which reads as "unsupported" and is the opposite.
- **`getrandom` gains `wasm_js` on WASM** and needs no build flag at 0.4.
- A target-specific dependency goes in a `[target.'cfg(…)'.dependencies]` table. That is the one
  place outside `src/platform/` a target is named, and the fence does not read it for that.
- **The `testing` feature is test scaffolding and nothing a build ships**: `schema::memory_pair`,
  `scratch`, `CardRow::from_json`, and every `pub mod fixtures` — `schema`'s,
  `sync_engine::capture`'s, and since the domain step `card`'s, `collection`'s, `deck`'s,
  `deck_tokens`', `maintenance`'s and `reset`'s. `src-tauri` asks for it under
  `[dev-dependencies]` only, and resolver 2 leaves that out of every build that is not a test.
  ⚠️ **Never name it on a host's `[dependencies]` line, never make it a default, never have
  another feature imply it — because two things behind it are not scaffolding**:
  `image_uri::is_allowed_host` lets a loopback host through under it, for the image fetcher's
  mock server, and `bulk_undo::with_store` keeps its tickets per thread under it, where a shipped
  build keeps one store for the process. Two things hold that, and only the second is complete:
  `platform::fence` sweeps every workspace member's manifest as text (a
  `[workspace.dependencies]` entry, a renamed dependency and a command-line `--features` all
  pass it), and CI's `rust` job fails when
  `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints
  `feature "testing"`. **A new host owes that step its own package name.**
- **`clippy --all-targets` and `cargo test` both turn `testing` on for the host's ordinary
  library too**, so neither notices a non-test use of the scaffolding. `cargo check -p
  mtg-grimoire --locked` is the build that ships; `npm run verify` and the `rust` job both run it.

## Commands

The crate is a member of the workspace at the repository root, so it shares `Cargo.lock`, the
`[profile.*]` blocks in the root `Cargo.toml`, and the build tree — which is still
`src-tauri/target` (`.cargo/config.toml` pins it).

| | |
| --- | --- |
| `cargo test -p grimoire-core` | This crate's tests alone, natively |
| `cargo test -p grimoire-core schema::` | The schema's — `cargo test -p mtg-grimoire schema::` runs only the 8 that stayed |
| `cargo test -p grimoire-core deck::` | A domain module's — the same, for any of the forty-nine; `-p mtg-grimoire deck::` runs only the 5 that stayed |
| `npm run verify` | Both members: `fmt --check`, `clippy -D warnings`, `cargo test --workspace` |
| `cargo build --lib -p grimoire-core --target wasm32-unknown-unknown` | The WASM compile. Needs clang 18 or newer for SQLite's C |

**On this machine clang is not on `PATH`** and `cc-rs` does not look for it:

```bash
CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe" AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe" cargo build --lib -p grimoire-core --target wasm32-unknown-unknown
```

The Android compile runs only in CI: there is no NDK here.

- **Never `cargo fmt --all`.** It follows path dependencies into `crates/card-scanner`, which is
  hand-formatted. `cargo fmt -p grimoire-core`.
- **A green suite here proves the desktop.** The `core` job proves the other two targets
  *compile*; nothing yet runs this crate in a browser or on a phone.
