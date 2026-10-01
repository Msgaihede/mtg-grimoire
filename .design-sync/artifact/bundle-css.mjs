// Rebuild the Design System artifact's components/bundle.css the way its migration did:
// styles.css + fonts/fonts.css + _ds_bundle.css joined under section comments, with one
// declaration taken out per token that tokens.css (generated from tokens.json) supplies.
// Usage: node .design-sync/artifact/bundle-css.mjs <artifactDir>/project <bundleDir> <pubDir>/project/components/bundle.css
import fs from "node:fs";
import path from "node:path";

const [, , oldDir, newDir, outFile] = process.argv;
const read = (dir, p) => fs.readFileSync(path.join(dir, p), "utf8");

/** Remove the first `--name: value;` declaration of each name, returning the css and what went. */
function strip(css, names) {
  const gone = [];
  for (const name of names) {
    const re = new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:[^;{}]*;?`);
    const m = re.exec(css);
    if (!m) continue;
    // Must be a declaration: preceded by `{` or `;` (or whitespace after one), not `var(`.
    let i = m.index;
    let found = null;
    const all = new RegExp(re.source, "g");
    for (const hit of css.matchAll(all)) {
      const before = css.slice(Math.max(0, hit.index - 1), hit.index);
      if (before === "{" || before === ";" || /\s/.test(before)) {
        found = hit;
        break;
      }
    }
    if (!found) continue;
    i = found.index;
    css = css.slice(0, i) + css.slice(i + found[0].length);
    gone.push(name);
  }
  return { css, gone };
}

const join = (styles, fonts, ds) =>
  `/* ── styles.css ── */\n${styles}\n/* ── fonts/fonts.css ── */\n${fonts}\n/* ── _ds_bundle.css ── */\n${ds}`;

// 1. Learn the token names from the page's own generated tokens.css.
const tokensCss = read(oldDir, "tokens.css");
const names = [...new Set([...tokensCss.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]))];

// 2. Check the rule against the old files: it must reproduce the old bundle.css's shape.
const oldBundle = read(oldDir, "components/bundle.css");
const oldDs = read(oldDir, "_ds_bundle.css");
const head = oldBundle.slice(0, oldBundle.indexOf("@layer properties"));
console.log("old bundle head sections:", JSON.stringify(head.match(/\/\* ── [^*]+ ── \*\//g)));
const oldDsPart = oldBundle.slice(oldBundle.indexOf("/* ── _ds_bundle.css ── */"));
console.log("old ds part head:", JSON.stringify(oldDsPart.slice(0, 60)));
const oldNames = [...new Set([...oldDs.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]))];
const count = (css, n) => [...css.matchAll(new RegExp(`${n}\\s*:`, "g"))].length;
const removedOld = oldNames.filter((n) => count(oldDs, n) > count(oldDsPart, n));
const re = strip(oldDs, removedOld);
const mine = `/* ── _ds_bundle.css ── */\n${re.css}`;
console.log(
  "rule reproduces old ds part:",
  mine.trim() === oldDsPart.trim(),
  "lens",
  mine.trim().length,
  oldDsPart.trim().length,
);
if (mine.trim() !== oldDsPart.trim()) {
  let i = 0;
  const a = mine.trim(),
    b = oldDsPart.trim();
  while (i < a.length && a[i] === b[i]) i++;
  console.log(
    "first diff at",
    i,
    JSON.stringify(a.slice(i - 80, i + 80)),
    "VS",
    JSON.stringify(b.slice(i - 80, i + 80)),
  );
}

// 3. Apply it to the new build.
const nStyles = read(newDir, "styles.css");
const nFonts = read(newDir, "fonts/fonts.css");
const nDs = read(newDir, "_ds_bundle.css");
// Strip exactly what the migration stripped — `removedOld` — and nothing newer: the page's
// generated tokens.css is stale (still lists the deleted pie colours, lacks the creature ones),
// so a token it does not supply has to stay declared here.
const out = strip(nDs, removedOld);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, join(nStyles, nFonts, out.css));
console.log(
  "token names in tokens.css:",
  names.length,
  "| stripped from new css:",
  out.gone.length,
);
console.log(
  "in tokens.css but not declared by the new css:",
  names.filter((n) => !out.gone.includes(n)).join(" ") || "(none)",
);
const newNames = [...new Set([...nDs.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]))];
console.log(
  "declared by the new css, not in tokens.css (stay in bundle.css), non --tw:",
  newNames.filter((n) => !names.includes(n) && !n.startsWith("--tw-")).join(" "),
);
// 4. Values: does tokens.css agree with the new css for the tokens it supplies?
const val = (css, n) => {
  const m = new RegExp(`(?:[{;\\s])${n.replace(/-/g, "\\-")}\\s*:\\s*([^;{}]+)`).exec(css);
  return m ? m[1].trim() : null;
};
const norm = (v) =>
  (v ?? "")
    .replace(/\s+/g, "")
    .replace(/var\((--[a-z0-9-]+)\)/gi, "$1")
    .toLowerCase();
const diffs = names
  .map((n) => [n, val(tokensCss, n), val(nDs, n)])
  .filter(([, a, b]) => b && norm(a) !== norm(b));
console.log("value differences (tokens.css vs new css):", diffs.length);
for (const d of diffs.slice(0, 20)) console.log("  ", d.join(" | "));
console.log("sizes: new ds", nDs.length, "→ bundle.css", fs.statSync(outFile).size);
