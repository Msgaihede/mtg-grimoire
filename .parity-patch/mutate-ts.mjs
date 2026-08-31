// Mutation harness. **Every mutation below changes a boolean, a string or a match arm.**
// Nothing here touches a path, a directory argument, or anything reachable by `sweep_dir`,
// `remove_dir_all` or `remove_file` — that is the rule this task carries, and the harness
// restores the exact original bytes after each run whether the test passed or failed.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset";
const VITEST = `${ROOT}/node_modules/vitest/vitest.mjs`;

const MUTATIONS = [
  {
    name: "T1 UpdatePanel: the web sentence names Google Play instead of the browser",
    file: "src/features/settings/UpdatePanel.tsx",
    from: `  web: "Updates arrive through your browser.",`,
    to: `  web: "Updates arrive through Google Play.",`,
    suite: "src/features/settings/UpdatePanel.test.tsx",
  },
  {
    name: "T2 UpdatePanel: selfUpdating forgets that something else may do the updating",
    file: "src/features/settings/UpdatePanel.tsx",
    from: `  const selfUpdating = status !== null && elsewhere === undefined;`,
    to: `  const selfUpdating = status !== null;`,
    suite: "src/features/settings/UpdatePanel.test.tsx",
  },
  {
    name: "T3 UpdatePanel: an absent status reads as self-updating again (#315's bug)",
    file: "src/features/settings/UpdatePanel.tsx",
    from: `  const elsewhere = status ? ELSEWHERE[status.installKind] : null;`,
    to: `  const elsewhere = status ? ELSEWHERE[status.installKind] : undefined;`,
    suite: "src/features/settings/UpdatePanel.test.tsx",
  },
  {
    name: "T4 SettingsPage: the panel is hidden on web again",
    file: "src/features/settings/SettingsPage.tsx",
    from: `      <UpdatePanel update={update} history={history} />`,
    to: `      {!isWebTarget() && <UpdatePanel update={update} history={history} />}`,
    suite: "src/features/settings/SettingsPage.test.tsx",
  },
  {
    name: "T5 useUpdate: the web target stops reading update_status at all",
    file: "src/lib/useUpdate.ts",
    from: `  useEffect(() => {
    let cancelled = false;`,
    to: `  useEffect(() => {
    if (isWebTarget()) return;
    let cancelled = false;`,
    suite: "src/lib/useUpdate.test.ts",
  },
];

for (const m of MUTATIONS) {
  const p = `${ROOT}/${m.file}`;
  const original = readFileSync(p, "utf8");
  if (!original.includes(m.from)) {
    console.log(`SKIPPED  ${m.name}\n         anchor not found`);
    continue;
  }
  if (original.split(m.from).length > 2) {
    console.log(`SKIPPED  ${m.name}\n         anchor not unique`);
    continue;
  }
  writeFileSync(p, original.replace(m.from, m.to));
  let caught = false;
  let detail = "";
  try {
    execFileSync("node", [VITEST, "run", "--root", ROOT, m.suite], {
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (e) {
    caught = true;
    const out = (e.stdout || "") + (e.stderr || "");
    const line = out.split("\n").find((l) => l.includes("Tests ") && l.includes("failed"));
    detail = (line || "").trim();
  } finally {
    writeFileSync(p, original);
  }
  console.log(`${caught ? "CAUGHT " : "SURVIVED"} ${m.name}`);
  if (detail) console.log(`         ${detail}`);
}
console.log("all files restored");
