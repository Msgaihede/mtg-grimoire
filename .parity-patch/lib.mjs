import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/lib.rs";
let s = readFileSync(p, "utf8");
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

// The two were ungated by hand for the measurement; put them back where they belong, in the
// every-target block, with the reason each one is now there.
must("pub mod reconcile;\npub mod reset;\n", "pub mod reconcile;\n");
must("pub mod transfer;\npub mod update;\n", "pub mod transfer;\n");

must(
  `pub mod nav;
pub mod schema;`,
  `pub mod nav;
/// **Three of Settings' four clears, moved here on 2026-08-31** — the deck domain's move a
/// day earlier, arrived at from the same finding. \`clear_collection\`, \`clear_wishlist\` and
/// \`clear_decks\` are \`&Connection\` in and a DTO out; what was holding the whole module on
/// the other side was the block of \`#[tauri::command]\` wrappers at its foot, and the gate
/// moved onto them.
///
/// **\`clear_cache\` is the one that did not come**, and it is the only thing in the file that
/// does not compile here: its \`cache\` parameter is [\`images\`]' type, and on web the byte
/// cache is Cache Storage rather than a directory. That is the same rewrite-not-a-port
/// \`images\` itself is, and it carries its own gate at its own site.
pub mod reset;
pub mod schema;`,
);

must(
  `pub mod sync;
/// **Every layer of the engine compiles for wasm`,
  `pub mod sync;
/// **The version, the release history and the clock they were read at — but never the swap.**
/// This module was §6.3's second permanent exclusion and only half of it ever was one: the
/// \`.exe\` replacement, the staging and the relaunch are Windows to the bone, while
/// \`UpdateStatus\`, [\`update::history\`] and the pure version comparison underneath them are a
/// \`serde\` struct and two \`app_meta\` reads. The half that swaps a file keeps the gate, item
/// by item; the half that *reports* is here, so \`update_status\` and \`update_history\` can be
/// answered on a target that has no executable to replace.
///
/// **What that buys is not a Download button, it is a decidable one.** \`UpdatePanel\` chooses
/// what to draw from \`installKind\`, which is an answer from this module — so where the
/// command did not answer at all, the panel read the silence as "not managed" and offered
/// controls a browser cannot honour. [\`update::InstallKind::Web\`] is the answer that was
/// missing.
pub mod update;
/// **Every layer of the engine compiles for wasm`,
);

writeFileSync(p, s);
console.log("lib.rs patched");
