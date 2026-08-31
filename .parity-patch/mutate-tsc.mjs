import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset";
const p = `${ROOT}/src/lib/ipc.ts`;
const original = readFileSync(p, "utf8");
const from = `export type InstallKind = "portable" | "nsis" | "managed" | "other" | "web";`;
const to = `export type InstallKind = "portable" | "nsis" | "managed" | "other";`;

writeFileSync(p, original.replace(from, to));
let caught = false;
let detail = "";
try {
  execFileSync("node", [`${ROOT}/node_modules/typescript/bin/tsc`, "-p", `${ROOT}/tsconfig.json`, "--noEmit"], {
    stdio: "pipe",
    encoding: "utf8",
  });
} catch (e) {
  caught = true;
  detail = ((e.stdout || "") + (e.stderr || "")).split("\n").slice(0, 4).join("\n");
} finally {
  writeFileSync(p, original);
}
console.log(`${caught ? "CAUGHT by tsc" : "SURVIVED tsc"} T7`);
if (detail) console.log(detail);
