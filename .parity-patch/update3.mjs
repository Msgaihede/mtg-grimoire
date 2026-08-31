import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
const GATE = '#[cfg(not(target_family = "wasm"))]';

// Nine items whose only callers are the check and the download, both of which are now the
// desktop's. Dead code is `-D warnings` on the wasm leg of CI, so each carries the gate too.
const anchors = [
  "const HISTORY_PER_PAGE: u32 = 30;",
  'const PORTABLE_EXE: &str = "mtg-grimoire.exe";',
  "const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;",
  "const PROGRESS_EMIT_BYTES: u64 = 256 * 1024;",
  "fn clear_app_meta(conn: &Connection, key: &str) -> rusqlite::Result<()> {",
  "fn sibling(path: &Path, suffix: &str) -> PathBuf {",
  "fn parse_release_page(v: &serde_json::Value) -> Vec<ReleaseInfo> {",
  "fn latest_of(page: &[ReleaseInfo]) -> Option<&ReleaseInfo> {",
  "fn parse_release(v: &serde_json::Value) -> Result<ReleaseInfo, String> {",
];
for (const a of anchors) {
  if (!s.includes(a)) throw new Error("NOT FOUND: " + a);
  if (s.split(a).length > 2) throw new Error("NOT UNIQUE: " + a);
  s = s.replace(a, GATE + "\n" + a);
}

writeFileSync(p, s);
console.log("update.rs patched (3)");
