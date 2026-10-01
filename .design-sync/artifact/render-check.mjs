// Renders the Design System page cards the way the artifact's frame does — React 18.3.1 from
// the artifact's own lib files, tokens.css, bundle.css, then the bundle INLINED (no script URL)
// — and photographs each one. Usage: node .design-sync/artifact/render-check.mjs <pubDir> <artifactDir> <bundleDir> <outDir>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const [, , pubDir, artifactDir, bundleDir, outDir] = process.argv;
// Playwright lives with the staged converter, which is gitignored and may sit in the main checkout
// rather than in a worktree: DS_SYNC_DIR names it, else `.ds-sync` beside the current directory.
const require = createRequire(path.resolve(process.env.DS_SYNC_DIR ?? ".ds-sync", "package.json"));
const { chromium } = require("playwright");

const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};
const read = (p) => fs.readFileSync(p);
const bundleJs = fs.readFileSync(path.join(bundleDir, "_ds_bundle.js"), "utf8");
console.log(
  "bundle bytes",
  bundleJs.length,
  "| literal </script:",
  (bundleJs.match(/<\/script/gi) || []).length,
  "| literal <!--:",
  (bundleJs.match(/<!--/g) || []).length,
);

/** project/<path> → bytes, from the publish tree first, then the new build, then the artifact. */
function resolve(rel) {
  const tries = [
    path.join(pubDir, "project", rel),
    rel.startsWith("card-art/") ? path.join(bundleDir, rel) : null,
    rel.startsWith("fonts/") ? path.join(bundleDir, rel) : null,
    path.join(artifactDir, "project", rel),
  ].filter(Boolean);
  for (const t of tries) if (fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  return null;
}

const frame = (name) => {
  const preview = fs.readFileSync(
    path.join(pubDir, "project", "components", name, "preview.html"),
    "utf8",
  );
  return `<!doctype html><html data-theme="default"><head><meta charset="utf-8">
<link rel="stylesheet" href="../../tokens.css">
<link rel="stylesheet" href="../bundle.css">
<script src="../lib/react.production.min.js"></script>
<script src="../lib/react-dom.production.min.js"></script>
<script>${bundleJs.replace(/<\/script/gi, "<\\/script")}</script>
</head><body>${preview}</body></html>`;
};

const misses = [];
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/project\//, "");
  const m = /^components\/([A-Za-z]+)\/frame\.html$/.exec(url);
  if (m) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(frame(m[1]));
  }
  const file = resolve(url);
  if (!file) {
    misses.push(url);
    res.writeHead(404);
    return res.end("no");
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(read(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.DS_CHROMIUM_PATH });
const names = fs
  .readdirSync(path.join(pubDir, "project", "components"))
  .filter((n) => fs.existsSync(path.join(pubDir, "project", "components", n, "preview.html")));
for (const name of names) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 300)));
  page.on(
    "console",
    (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 300)),
  );
  await page.goto(`http://127.0.0.1:${port}/project/components/${name}/frame.html`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(800);
  const facts = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("img")];
    return {
      react: window.React && window.React.version,
      rootText: document.getElementById("ds-root").innerText.slice(0, 120).replace(/\s+/g, " "),
      rootHeight: document.getElementById("ds-root").getBoundingClientRect().height,
      imgs: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      srcKinds: [
        ...new Set(
          imgs.map((i) =>
            (i.currentSrc || i.src).startsWith("data:")
              ? "data:"
              : new URL(i.currentSrc || i.src).pathname.replace(/[^/]+$/, ""),
          ),
        ),
      ],
    };
  });
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  console.log(
    name,
    JSON.stringify(facts),
    errors.length ? "ERRORS: " + errors.join(" || ") : "no errors",
  );
  await page.close();
}
await browser.close();
server.close();
console.log("404s:", [...new Set(misses)].slice(0, 12).join(", ") || "(none)");
