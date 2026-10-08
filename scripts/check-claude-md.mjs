import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_LINES = 200;
const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  "node_modules",
  "target",
  "dist",
  "apps/light/dist-web",
  "apps/share/dist-share",
  "dist-wasm",
  "storybook-static",
]);

/**
 * Recursively find all CLAUDE.md files in the repository.
 * @param {string} dir
 * @returns {string[]}
 */
export function findClaudeFiles(dir = ".") {
  const claudeFiles = [];

  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(join(currentDir, entry.name));
        }
      } else if (entry.isFile() && entry.name === "CLAUDE.md") {
        claudeFiles.push(join(currentDir, entry.name));
      }
    }
  }

  walk(dir);
  return claudeFiles.sort();
}

/**
 * Counts the lines of a file text.
 * @param {string} content
 * @returns {number}
 */
export function countLines(content) {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

/**
 * Validates that every CLAUDE.md file is <= MAX_LINES lines.
 * @param {string} rootDir
 * @returns {{ ok: boolean, results: Array<{ file: string, lines: number, ok: boolean }> }}
 */
export function checkClaudeBudgets(rootDir = ".") {
  const files = findClaudeFiles(rootDir);
  const results = [];
  let allOk = true;

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = countLines(content);
    const ok = lines <= MAX_LINES;
    if (!ok) allOk = false;
    results.push({ file: relative(rootDir, file).replace(/\\/g, "/"), lines, ok });
  }

  return { ok: allOk, results };
}

function main() {
  const { ok, results } = checkClaudeBudgets(".");

  console.log(`Checking line count for all CLAUDE.md files (max: ${MAX_LINES} lines):`);
  for (const { file, lines, ok: fileOk } of results) {
    if (fileOk) {
      console.log(`  ✓ ${file}: ${lines} lines`);
    } else {
      console.error(`  ❌ ${file}: ${lines} lines (EXCEEDS ${MAX_LINES} line budget!)`);
    }
  }

  if (!ok) {
    console.error(`\nFAILED: One or more CLAUDE.md files exceed the ${MAX_LINES} line budget.`);
    process.exit(1);
  }

  console.log(`\nPASSED: All ${results.length} CLAUDE.md files are within the ${MAX_LINES} line budget.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
