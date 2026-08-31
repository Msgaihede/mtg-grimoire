import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

must(
  `        let (state, _dir) = file_state("status-for");
        let release = parse_release(&live_payload()).unwrap();
        {`,
  `        let (state, _dir) = file_state("status-for");
        let mut release = parse_release(&live_payload()).unwrap();
        // **The payload's own \`v0.2.0\` is not newer than this build and would be filtered
        // out**, which would make every assertion below pass for the wrong reason. Derived
        // from the running version rather than written down, so this does not rot at the
        // next release — \`status_for\` re-compares the cache through \`is_newer\` on every
        // read, which is the behaviour being relied on here.
        let major: u32 = current_version().split('.').next().unwrap().parse().unwrap();
        release.version = format!("{}.0.0", major + 1);
        {`,
);

must(
  `        // A portable install on 0.1.0 is offered the release and its asset.`,
  `        // A portable install is offered the release and the asset it could install.`,
);

writeFileSync(p, s);
console.log("update.rs tests patched (3)");
