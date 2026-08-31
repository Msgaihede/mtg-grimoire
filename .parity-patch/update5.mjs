import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

// Both refusals already read "this kind of install cannot be updated from inside the app",
// which is exactly true of `Web` too. Named rather than swept into a `_` for `pick_asset`'s
// reason: a fifth kind should make the compiler ask, not inherit a refusal by default.
must(
  `        InstallKind::Managed | InstallKind::Other => {
            let _ = std::fs::remove_file(&part);
            return Err("this kind of install cannot be updated from inside the app.".into());
        }`,
  `        InstallKind::Managed | InstallKind::Web | InstallKind::Other => {
            let _ = std::fs::remove_file(&part);
            return Err("this kind of install cannot be updated from inside the app.".into());
        }`,
);

must(
  `        InstallKind::Managed | InstallKind::Other => {
            return Err("this kind of install cannot be updated from inside the app.".into())
        }`,
  `        InstallKind::Managed | InstallKind::Web | InstallKind::Other => {
            return Err("this kind of install cannot be updated from inside the app.".into())
        }`,
);

// The comment above the second one names the two kinds it is unreachable for.
must(
  `        // Unreachable in practice — nothing can be staged for either, because \`pick_asset\`
        // refuses them and \`download\` refuses them again.`,
  `        // Unreachable in practice — nothing can be staged for any of them, because
        // \`pick_asset\` refuses them and \`download\` refuses them again. \`Web\` is doubly so:
        // this whole function is gated off that target.`,
);

writeFileSync(p, s);
console.log("update.rs patched (5)");
