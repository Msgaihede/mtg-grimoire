import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset";
const VITEST = `${ROOT}/node_modules/vitest/vitest.mjs`;

// No path, directory or filesystem argument is mutated anywhere in this file.
const MUTATIONS = [
  {
    name: "T3b UpdatePanel: an absent status reads as self-updating (#315's own bug)",
    file: "src/features/settings/UpdatePanel.tsx",
    from: `  const selfUpdating = status !== null && elsewhere === undefined;`,
    to: `  const selfUpdating = elsewhere === undefined;`,
    suite: "src/features/settings/UpdatePanel.test.tsx",
  },
  {
    name: "T5b useUpdate: the web target stops reading update_status at all",
    file: "src/lib/useUpdate.ts",
    from: `  useEffect(() => {
    let cancelled = false;`,
    to: `  useEffect(() => {
    if (isWebTarget()) return;
    let cancelled = false;`,
    suite: "src/lib/useUpdate.test.ts",
  },
  {
    name: "T6 useUpdate: the web target polls forever instead of reading once",
    file: "src/lib/useUpdate.ts",
    from: `      if (!isWebTarget()) timer = setTimeout(poll, POLL_MS);`,
    to: `      timer = setTimeout(poll, POLL_MS);`,
    suite: "src/lib/useUpdate.test.ts",
  },
  {
    name: "T7 ipc: the web install kind leaves the InstallKind union",
    file: "src/lib/ipc.ts",
    from: `export type InstallKind = "portable" | "nsis" | "managed" | "other" | "web";`,
    to: `export type InstallKind = "portable" | "nsis" | "managed" | "other";`,
    suite: "src/features/settings/UpdatePanel.test.tsx",
  },
];

for (const m of MUTATIONS) {
  const p = `${ROOT}/${m.file}`;
  const original = readFileSync(p, "utf8");
  if (!original.includes(m.from) || original.split(m.from).length > 2) {
    console.log(`SKIPPED  ${m.name}`);
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
    detail = (out.split("\n").find((l) => l.includes("Tests ") && l.includes("failed")) || "").trim();
  } finally {
    writeFileSync(p, original);
  }
  console.log(`${caught ? "CAUGHT " : "SURVIVED"} ${m.name}`);
  if (detail) console.log(`         ${detail}`);
}
console.log("all files restored");
