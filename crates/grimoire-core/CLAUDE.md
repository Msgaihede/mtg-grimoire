# grimoire-core — the engine with no window

What every host links: the desktop app in `src-tauri` today, an Android shell and a WASM build in
a Worker later. The design is
[the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md)
§2; what each extraction step built and measured is in
[light-app.md](../../docs/reference/light-app.md).

**It is being filled a step at a time, and most of the engine is still in `src-tauri`.** What is
here is what `src/lib.rs` declares: the leaves, and since 2026-10-02 the storage layer — `db`,
`schema` with both ladders, `sync_meta`, `filters`, `sorting`, `card_row`, `image_uri`, `errors`,
`feed::backoff` and `sync_engine::capture`. Every rule in
[`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) about a module binds that module wherever it
lives — moving a file changes which crate compiles it and nothing about what it must do. **That
file's database rules are this crate's now**: a schema rung, a grain, a capture spec is edited
here.

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
**`schema` names `std::fs` directly** (the corpus it replaces, the backup before a climb, the
damage mark): that compiles for a browser and fails there when called, and waits for the I/O
step.

**Most of the engine never asks for the time.** The domain modules use SQLite's `unixepoch()`
and `date('now')` inside the statement that needs them, which is the same on every host.

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

## What a moved module left in `src-tauri`

Each row goes home in the step that moves what it names.

| Module | Still in `src-tauri` | Because it names | Home with |
| --- | --- | --- | --- |
| `schema` (`src/schema/mod.rs`) | `prepare_database` — `schema::bring_to_head` here, then the launch's logged passes | `maintenance`, `managed_wishlist`, `deck_tokens`, `deck_meta` | step 4 |
| `schema` | `prepare_data_dir` — `split::convert`, then `schema::replace_unreadable_corpus` here | `split`, which only the desktop has | never: `split` stays |
| `schema` | 17 of its 280 tests | the launch, `split`, `deck_tokens`, `deck_todos`, `deck`, `tags::query`, `maintenance` | steps 4 and 5 |
| `sync_engine::capture` | 3 of its 42 tests, in `sync_engine/capture_tests.rs` | `reconcile`, the launch | step 4 |
| `errors` (`src/errors/mod.rs`) | `kind_of` and its test | `scryfall::ScryfallError` | step 5 |

**`bring_to_head` is every step of a launch that may stop it**: `migrate_user`, `migrate_corpus`
(or the corpus replaced), then `capture::clear_stale_guard` and `capture::install`. A host that
opens a database calls it; what the desktop does after it is logged and left owing.

⚠️ **A new user rung owes its `UNDO_V<N>` in two files while this lasts**: the constant goes in
`schema::fixtures` here, at the head of every chain in this file's tests — and at the head of
the one chain that stayed, in `src-tauri/src/schema/mod.rs`'s
`migrate_the_real_database_to_v29`. That test is `#[ignore]`d, so nothing goes red for it.

The other direction, once: `sync_meta` holds `K_FTS_REBUILD_PENDING`, which is
`maintenance`'s flag, because `schema::swap_staging` clears it. `maintenance` re-exports it and
takes it back when it moves.

## The manifest

- **`rusqlite` is two lines**: `bundled` plus `hooks` everywhere but WASM, and `hooks` alone
  there. ⚠️ **Never `default-features = false` on the WASM line** — the backend that makes
  SQLite build for a browser is in rusqlite's default set, and switching it off fails with
  `unresolved import libsqlite3_sys`, which reads as "unsupported" and is the opposite.
- **`getrandom` gains `wasm_js` on WASM** and needs no build flag at 0.4.
- A target-specific dependency goes in a `[target.'cfg(…)'.dependencies]` table. That is the one
  place outside `src/platform/` a target is named, and the fence does not read it for that.
- **The `testing` feature is test scaffolding and nothing a build ships**: `schema::memory_pair`,
  `schema::fixtures`, `sync_engine::capture::fixtures`, `scratch` and `CardRow::from_json`.
  `src-tauri` asks for it under `[dev-dependencies]` only, and resolver 2 leaves that out of
  every build that is not a test. ⚠️ **Never name it on a host's `[dependencies]` line.**
  `cargo tree -p mtg-grimoire -e features,normal -i grimoire-core` is the check.

## Commands

The crate is a member of the workspace at the repository root, so it shares `Cargo.lock`, the
`[profile.*]` blocks in the root `Cargo.toml`, and the build tree — which is still
`src-tauri/target` (`.cargo/config.toml` pins it).

| | |
| --- | --- |
| `cargo test -p grimoire-core` | This crate's tests alone, natively |
| `cargo test -p grimoire-core schema::` | The schema's — `cargo test -p mtg-grimoire schema::` runs only the 17 that stayed |
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
