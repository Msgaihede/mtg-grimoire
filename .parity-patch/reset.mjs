import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/reset.rs";
let s = readFileSync(p, "utf8");
const before = s;
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 90));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 90));
  s = s.replace(from, to);
}

// 1. Imports: gate the ones only the desktop command wrappers and `clear_cache` reach.
must(
  `use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::sync::{with_write, AppState};`,
  `use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::Path;

// **Gated rather than deleted, because an unused import is a red build on the web target.**
// CI runs \`cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings\`, and every one
// of these is reachable only from [\`clear_cache\`] or from the \`#[tauri::command]\` block at
// the foot of this file — all of which carry the same gate.
#[cfg(not(target_family = "wasm"))]
use std::sync::atomic::Ordering;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};`,
);

// 2. `clear_cache` is the one function here that does not compile for wasm.
must(
  `pub fn clear_cache(
    conn: &Connection,`,
  `/// **The one thing in this file the web target does not get, and [\`crate::images\`] is the
/// whole reason.** The \`cache\` parameter is that module's type; on web the byte cache is
/// Cache Storage rather than a directory, which is a rewrite and not a port, and its own
/// piece of work. Everything above this line is ordinary SQLite and compiles everywhere,
/// which is why the other three clears are routed and this one is not.
#[cfg(not(target_family = "wasm"))]
pub fn clear_cache(
    conn: &Connection,`,
);

// 3. The command wrappers, and the refusal string only the fourth of them uses.
must(
  `/// Refused when a sync is in flight, in the reader's words.
const SYNCING: &str = "a card update is running — clear the cache once it has finished";

#[tauri::command]
pub async fn collection_clear(`,
  `/// Refused when a sync is in flight, in the reader's words.
#[cfg(not(target_family = "wasm"))]
const SYNCING: &str = "a card update is running — clear the cache once it has finished";

// ── The command wrappers, and only they, are the desktop's ───────────────────────────────
//
// **The gate is on this block rather than on the module**, which is the shape \`search.rs\`
// has always had and the one PR 10a moved eleven other modules into. Everything above is
// \`&Connection\` in and a DTO out; what cannot cross is \`tauri::State\`, \`tauri::AppHandle\`
// and [\`crate::paths::covers_dir\`]. Three of the four are reachable from a browser through
// [\`crate::web::route\`] instead — and the fourth, \`cache_clear\`, is not: see [\`clear_cache\`]
// above for why the image cache is a separate piece of work rather than a missing arm.

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn collection_clear(`,
);

for (const name of ["wishlist_clear", "decks_clear", "cache_clear"]) {
  must(
    `#[tauri::command]\npub async fn ${name}(`,
    `#[cfg(not(target_family = "wasm"))]\n#[tauri::command]\npub async fn ${name}(`,
  );
}

if (s === before) throw new Error("no change");
writeFileSync(p, s);
console.log("reset.rs patched");
