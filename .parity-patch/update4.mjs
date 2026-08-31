import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
const GATE = '#[cfg(not(target_family = "wasm"))]';
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

// `rusqlite` is reached only through `clear_app_meta` now — every other read in this file
// goes through `crate::app_meta`, which takes the connection as an argument.
must(
  `use rusqlite::{params, Connection};`,
  `${GATE}
use rusqlite::{params, Connection};`,
);

// `PathBuf` belonged to `Staged`, `Updater` and `sibling`; `Path` still has ungated callers
// in `install_kind_for` and `detect_install_kind`.
must(
  `use std::path::{Path, PathBuf};`,
  `use std::path::Path;
${GATE}
use std::path::PathBuf;`,
);

writeFileSync(p, s);
console.log("update.rs patched (4)");
