---
paths:
  - "**/*.rs"
---

# rust-analyzer over grep

The `rust-analyzer-lsp` plugin is active for every `.rs` file — no setup, nothing to switch
on. All nine `LSP` operations were driven against this tree on 2026-09-01.

## Reach for it when the question is semantic

Grep answers "where does this string appear". The LSP answers "what is this symbol", which is a
different question and usually the one you have. Measured here: `findReferences` on `db::open`
returned 10 references across `db.rs`, `split.rs` and `schema.rs` **and correctly left out
`Connection::open`** — a text search cannot make that distinction and will hand you rusqlite's
method as a caller of ours. `outgoingCalls` resolves through to crates.io and the stdlib, so it
will name `rusqlite::Connection::open` and `Path::join` as the callees of `db::open_write`.

Prefer `hover` / `goToDefinition` / `incomingCalls` for "who calls this", "what is this type",
"is this still used". Keep grep for strings, comments, SQL and anything spanning both languages.

## Four traps, each measured

**A cold server says "not on a symbol" when it means "not ready yet".** The first call after a
launch can take **~4 minutes** (cargo metadata plus the proc-macro build) and until then returns
*"No hover information available. This may occur if the cursor is not on a symbol, or if the LSP
server has not fully indexed the file."* The position is usually fine. **Re-issue the identical
call rather than hunting for a better line/character** — moving the cursor is the wrong reflex and
costs the session. A *warm* restart is only 30–40s. To tell warming from broken, poll
`(Get-Process rust-analyzer).CPU` until it stops climbing; a flat counter on a query that returns
nothing means the file is genuinely outside the loaded workspace.

**`documentSymbol` line numbers point at the doc comment, not the declaration.** It reports the
symbol's whole range, so `pub fn open` at `db.rs:113` is reported as **line 106** — the first
`///` line. With doc comments as long as this repo's, that is routinely 6+ lines off.
`workspaceSymbol` does *not* do this and reported `apply_pragmas` at its real line 94. **Never
cite a `documentSymbol` line number as a declaration site**; confirm with `workspaceSymbol` or a
read.

**The loaded workspace is the cargo workspace at the repository root** — `src-tauri` and
`crates/grimoire-core` — since 2026-10-02; until then `src-tauri` was a standalone package and
the only thing loaded. **No measurement on this page was repeated after that change**, so a first
query inside `crates/grimoire-core` that comes back empty is a cold server or an unmeasured case
before it is a broken one. The one crate with `.rs` outside the workspace is
`crates/card-scanner`, which is deliberately not a member (the root `Cargo.toml` excludes it and
its own says why) but is a path dependency of `src-tauri`, so rust-analyzer reaches it through
that dependency rather than as a workspace of its own. How the server answers inside it has not
been measured here; if a query there comes back empty, confirm with grep and a read before
calling the server broken. (The `spike/` wasm probes that this paragraph used to describe were deleted on
2026-09-27; they had their own standalone `[workspace]` and resolved nothing.)

**A `rust-analyzer.toml` in this repo does nothing — do not add one.** Verified across two clean
restarts, at both the repo root and `src-tauri/`, with every path spelling: `files.exclude` naming
a known-good file left that file hovering normally, and `hover.documentation.enable = false` was
ignored too. Any rust-analyzer setting has to come from the client. A committed
`rust-analyzer.toml` would be a tracked file that does nothing and could never go red.
