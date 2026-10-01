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

/** Components the artifact has never held: everything of theirs goes up. */
const NEW = new Set([
  "StackView",
  "CardStack",
  "CardChin",
  "QuantityTag",
  "Dropdown",
  "TooltipProvider",
  "WorkInProgress",
]);

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

// Per-component docs: prompt.md and .d.ts for every component (props move); the converter's own
// card html, its jsx stub and its compiled preview only for the components new to the artifact.
const names = [];
for (const group of fs.readdirSync(B("components"))) {
  for (const name of fs.readdirSync(B("components", group))) {
    names.push(`${group}/${name}`);
    const src = (ext) => B("components", group, name, `${name}.${ext}`);
    put(P("components", group, name, `${name}.prompt.md`), src("prompt.md"));
    add(core, `components/${group}/${name}/${name}.prompt.md`);
    put(P("components", group, name, `${name}.d.ts`), src("d.ts"));
    add(core, `components/${group}/${name}/${name}.d.ts`, "text/plain");
    if (!NEW.has(name)) continue;
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

// README: the converter's (conventions header + generated), then the migration section the
// artifact's README already carried, verbatim.
const oldReadme = fs.readFileSync(path.join(artifactDir, "project", "README.md"), "utf8");
const cut = oldReadme.indexOf("## Migrated from a legacy design system");
if (cut < 0) throw new Error("the artifact README has no migration section to keep");
const newReadme = fs.readFileSync(B("README.md"), "utf8").trimEnd();
fs.writeFileSync(P("README.md"), `${newReadme}\n\n${oldReadme.slice(cut)}`);

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
