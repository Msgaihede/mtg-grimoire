import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
const GATE = '#[cfg(not(target_family = "wasm"))]';
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

// `verify_digest` is the only thing that hashes, and its only caller is `download_inner`.
must(
  `use sha2::{Digest, Sha256};`,
  `// With the download gated away, [\`verify_digest\`] is the only thing left that hashes, and
// it goes with it — so this import would be unused on wasm, which CI treats as a red build.
${GATE}
use sha2::{Digest, Sha256};`,
);
must(
  `fn verify_digest(expected: Option<&str>, actual: &[u8]) -> Result<(), String> {`,
  `${GATE}
fn verify_digest(expected: Option<&str>, actual: &[u8]) -> Result<(), String> {`,
);

// `pick_asset` must say something about the new variant rather than fall through a wildcard.
must(
  `        // Neither can download anything, for opposite reasons: \`Other\` because nothing here
        // knows what would install it, \`Managed\` because something else already does.
        InstallKind::Managed | InstallKind::Other => return None,`,
  `        // None of the three can download anything. \`Other\` because nothing here knows what
        // would install it; \`Managed\` and \`Web\` because something else already does — the
        // store on a phone, the service worker in a browser. **Listed rather than swept up by
        // a \`_\`**, so the day a fourth kind is added the compiler asks what it downloads
        // instead of quietly answering \`None\` for it.
        InstallKind::Managed | InstallKind::Web | InstallKind::Other => return None,`,
);

writeFileSync(p, s);
console.log("update.rs patched (2)");
