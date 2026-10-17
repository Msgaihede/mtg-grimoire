// Lays the converter's ds-bundle/ out in the Design System artifact's migrated layout, under
// <pub>/project/, and writes the `files` lists the publish calls take.
// Usage: node .design-sync/artifact/assemble.mjs <bundleDir> <artifactDir> <pubDir>
import fs from "node:fs";
import path from "node:path";

const [, , bundleDir, artifactDir, pubDir] = process.argv;
const P = (...p) => path.join(pubDir, "project", ...p);
const B = (...p) => path.join(bundleDir, ...p);
const put = (to, from) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const core = []; // call 1
const add = (list, rel, contentType) =>
  list.push(contentType ? { path: `project/${rel}`, contentType } : { path: `project/${rel}` });

// The bundle and its stylesheets. components/bundle.css is written by bundle-css.mjs already.
put(P("components", "bundle.js"), B("_ds_bundle.js"));
put(P("_ds_bundle.css"), B("_ds_bundle.css"));
put(P("styles.css"), B("styles.css"));
put(P("fonts", "fonts.css"), B("fonts", "fonts.css"));
for (const rel of [
  "components/bundle.js",
  "components/bundle.css",
  "_ds_bundle.css",
  "styles.css",
  "fonts/fonts.css",
])
  add(core, rel);

// Font files the artifact does not hold yet (same names → nothing to send).
const have = new Set(
  JSON.parse(fs.readFileSync(path.join(artifactDir, "project", "manifest.json"), "utf8")).files,
);
for (const f of fs.readdirSync(B("fonts"))) {
  if (f === "fonts.css" || have.has(`fonts/${f}`)) continue;
  put(P("fonts", f), B("fonts", f));
  add(core, `fonts/${f}`);
  console.log("new font file:", f);
}

// Per-component docs, for every component: prompt.md and .d.ts (props move), the converter's own
// card html, its jsx stub and its compiled preview. Until 2026-10-17 the last three went up only
// for components new to the artifact; the previews are compiled against the bundle beside them,
// so a rebuilt bundle with old previews is a pair that was never verified together.
const names = [];
for (const group of fs.readdirSync(B("components"))) {
  for (const name of fs.readdirSync(B("components", group))) {
    names.push(`${group}/${name}`);
    const src = (ext) => B("components", group, name, `${name}.${ext}`);
    put(P("components", group, name, `${name}.prompt.md`), src("prompt.md"));
    add(core, `components/${group}/${name}/${name}.prompt.md`);
    put(P("components", group, name, `${name}.d.ts`), src("d.ts"));
    add(core, `components/${group}/${name}/${name}.d.ts`, "text/plain");
    put(P("components", group, name, `${name}.html`), src("html"));
    add(core, `components/${group}/${name}/${name}.html`, "text/plain");
    put(P("docs", "components", group, name, `${name}.jsx`), src("jsx"));
    add(core, `docs/components/${group}/${name}/${name}.jsx`, "text/plain");
    put(P("assets", "_preview", `${name}.js`), B("_preview", `${name}.js`));
    add(core, `assets/_preview/${name}.js`);
  }
}

// The page cards page-cards.mjs wrote.
for (const name of fs.readdirSync(P("components"))) {
  if (fs.existsSync(P("components", name, "preview.html")))
    add(core, `components/${name}/preview.html`);
}

// Components the artifact holds and the build no longer makes (Ribbon, 2026-10-11): every file of
// theirs comes out, as `null` entries — a publish's map form, so they go in a call of their own.
// What the artifact holds is read from the two places that name its components with their group:
// the migration's card manifest and the page cards' `@dsCard` lines. The page's generated
// `api/components/<Name>.md` is never written, so it is not listed here either.
const built = new Set(names.map((n) => n.split("/")[1]));
const held = new Map(); // name -> group
const legacy = JSON.parse(
  fs.readFileSync(path.join(artifactDir, "project", "docs", "_ds_manifest.json"), "utf8"),
);
for (const c of legacy.components ?? []) {
  const group = /^components\/([^/]+)\//.exec(c.sourcePath ?? "")?.[1];
  if (group) held.set(c.name, group);
}
const cardsDir = path.join(artifactDir, "project", "components");
for (const name of fs.existsSync(cardsDir) ? fs.readdirSync(cardsDir) : []) {
  const card = path.join(cardsDir, name, "preview.html");
  if (!fs.existsSync(card)) continue;
  const group = /@dsCard group="([^"]+)"/.exec(fs.readFileSync(card, "utf8"))?.[1];
  if (group && !held.has(name)) held.set(name, group);
}
const removed = {};
for (const [name, group] of held) {
  if (built.has(name)) continue;
  for (const rel of [
    `components/${name}/preview.html`,
    `components/${group}/${name}/${name}.prompt.md`,
    `components/${group}/${name}/${name}.d.ts`,
    `components/${group}/${name}/${name}.html`,
    `docs/components/${group}/${name}/${name}.jsx`,
    `assets/_preview/${name}.js`,
  ])
    removed[`project/${rel}`] = null;
  console.log("gone from the build:", `${group}/${name}`);
}
fs.writeFileSync(path.join(pubDir, "files-remove.json"), JSON.stringify(removed, null, 1));

// README: the converter's (conventions header + generated), then the migration section the
// artifact's README already carried, verbatim.
const oldReadme = fs.readFileSync(path.join(artifactDir, "project", "README.md"), "utf8");
const cut = oldReadme.indexOf("## Migrated from a legacy design system");
if (cut < 0) throw new Error("the artifact README has no migration section to keep");
const newReadme = fs.readFileSync(B("README.md"), "utf8").trimEnd();
fs.writeFileSync(P("README.md"), `${newReadme}\n\n${oldReadme.slice(cut)}`);
add(core, "README.md");

// The art.
const art = [];
for (const kind of ["normal", "art_crop"]) {
  for (const f of fs.readdirSync(B("card-art", kind))) {
    put(P("card-art", kind, f), B("card-art", kind, f));
    add(art, `card-art/${kind}/${f}`);
  }
}

const bytes = (list) => list.reduce((n, e) => n + fs.statSync(path.join(pubDir, e.path)).size, 0);
fs.writeFileSync(path.join(pubDir, "files-core.json"), JSON.stringify(core));
fs.writeFileSync(path.join(pubDir, "files-art.json"), JSON.stringify(art));
console.log("components:", names.length, names.join(" "));
console.log(
  "core:",
  core.length,
  "files,",
  (bytes(core) / 1e6).toFixed(2),
  "MB | art:",
  art.length,
  "files,",
  (bytes(art) / 1e6).toFixed(2),
  "MB",
);
console.log(
  "README:",
  fs.statSync(P("README.md")).size,
  "bytes; bundle.js",
  fs.statSync(P("components", "bundle.js")).size,
);
