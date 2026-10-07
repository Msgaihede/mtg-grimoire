#!/usr/bin/env node
// The light app's raster icons, rendered from the one master mark.
//
//     node scripts/light-icons.mjs
//
// A web manifest wants PNGs, and a maskable one besides: Android cuts an installed app's icon to
// whatever shape the launcher uses, and keeps only a circle 80% of its width whole. So there are
// four drawings here, all from `logos/svg/mtg-grimoire-mark.svg` and none a file of its own —
// a third SVG beside the mark and the tile is a third thing to forget when the mark changes:
//
//   - **the mark**, transparent, as the desktop's icon is (`logos/README.md` has why the tile is
//     not the icon), at 192 and 512;
//   - **the maskable mark**, on the app's ground (`--color-bg`, `#0C0D12`) to every edge, drawn
//     small enough that the whole of it — clasp and ribbon too — is inside that circle;
//   - **the launcher's layers**, for Android's adaptive icon: the mark alone and transparent on
//     a 108dp square, smaller still, because a launcher keeps only a circle 66dp across; the
//     ground behind it is a colour the Android project already has (`@color/ground`). And the
//     48dp icon no phone this app installs on draws (minSdk 26), which is the maskable drawing;
//   - **the store's**: the maskable drawing at 512 for the listing's icon, and the mark on the
//     ground at 1024×500 for its feature graphic — a JPEG, because Play takes no alpha there.
//
// The renderer is a browser, because that is what this repository has: no image library is a
// dependency and none is added for a handful of pictures. Headless Chromium over the DevTools protocol, as
// `web-smoke.mjs` drives it; `CHROME` names the browser, else the first of Chrome and Edge found
// installed. It writes `mobile/public/icons/`, the Android launcher's `res/mipmap-*` under
// `mobile/src-tauri/gen/android`, and the store's two graphics under `docs/play/` — all
// committed; nothing runs this in a build.
//
// **It measures what it drew.** The maskable mark's and the launcher foreground's scales are
// numbers somebody chose, and a safe zone is a rule a number can break without anything looking
// wrong on a square preview. So the page reports the furthest painted pixel from the centre, and
// a mark that reaches past its circle fails the run instead of shipping.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MARK = resolve("logos/svg/mtg-grimoire-mark.svg");
const OUT = resolve("mobile/public/icons");
const ANDROID_RES = resolve("mobile/src-tauri/gen/android/app/src/main/res");
const PLAY = resolve("docs/play");

/**
 * `--color-bg` in sRGB — `logos/README.md`'s field, and the manifest's two colours.
 * `mobile/host.test.ts` holds this line equal to the manifest's `background_color`, so a ground
 * that moves there goes red until it moves here — which is the reminder to render again.
 */
const GROUND = "#0C0D12";

/**
 * The mark's scale on the maskable icon, against 0.92 on the transparent one.
 *
 * The art's furthest point from the book's centre is a corner of the back board, 34.4 units out
 * on the 64-unit grid, plus half a stroke: about 35.3. The safe zone's radius is 40% of the
 * width, 25.6 units — so anything up to 0.725 fits, and 0.70 leaves a little air. `measure` below
 * checks the pixels rather than this arithmetic.
 */
const MASKABLE_SCALE = 0.7;
/** The share of the icon's width, from its centre, a maskable icon may count on keeping. */
const SAFE_RADIUS = 0.4;

/**
 * The mark's scale on the Android launcher's foreground layer.
 *
 * An adaptive icon's layer is 108dp square and a launcher shows a 72dp window of it, cut to its
 * own shape; only a circle 66dp across is promised whole. That is a radius of 33/108 of the
 * width — 30.6%, against the maskable icon's 40% — so the mark is drawn smaller again: 0.70
 * reaches 37.5% (measured), and 0.55 is that in proportion with a little air. `measure` checks
 * the pixels.
 */
const ADAPTIVE_SCALE = 0.55;
const ADAPTIVE_SAFE_RADIUS = 33 / 108;

/** Android's densities, as multiples of a dp. */
const DENSITIES = [
  { name: "mdpi", scale: 1 },
  { name: "hdpi", scale: 1.5 },
  { name: "xhdpi", scale: 2 },
  { name: "xxhdpi", scale: 3 },
  { name: "xxxhdpi", scale: 4 },
];

/**
 * Every picture this writes. `kind` is the drawing: `plain` (the mark, transparent),
 * `maskable` (smaller, on the ground to every edge), `adaptive` (smaller still, transparent)
 * and `feature` (the store's banner). A square one names a `size`; the banner its two sides.
 */
const ICONS = [
  { dir: OUT, file: "icon-192.png", size: 192, kind: "plain" },
  { dir: OUT, file: "icon-512.png", size: 512, kind: "plain" },
  { dir: OUT, file: "maskable-192.png", size: 192, kind: "maskable" },
  { dir: OUT, file: "maskable-512.png", size: 512, kind: "maskable" },
  ...DENSITIES.flatMap(({ name, scale }) => [
    {
      dir: join(ANDROID_RES, `mipmap-${name}`),
      file: "ic_launcher.png",
      size: 48 * scale,
      kind: "maskable",
    },
    {
      dir: join(ANDROID_RES, `mipmap-${name}`),
      file: "ic_launcher_foreground.png",
      size: 108 * scale,
      kind: "adaptive",
    },
  ]),
  { dir: PLAY, file: "listing-icon-512.png", size: 512, kind: "maskable" },
  { dir: PLAY, file: "feature-graphic-1024x500.jpg", width: 1024, height: 500, kind: "feature" },
];

/**
 * The adaptive icon itself: two layers by name. Written here rather than by hand so the set is
 * one command; `mobile/host.test.ts` holds its two lines.
 */
const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  WRITTEN BY scripts/light-icons.mjs — the launcher's icon on every phone this app installs on
  (minSdk 26). The ground is the app's own (\`values/colors.xml\`); the mark is rendered from
  \`logos/svg/mtg-grimoire-mark.svg\` inside the 66dp circle a launcher keeps whole.
  \`tauri android init\` does not write this file and overwrites the pictures beside it:
  \`mobile/host.test.ts\` holds both.
-->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ground" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** What to stop, newest first — pushed the moment each exists, as `web-smoke.mjs` does. */
const undo = [];
async function stopEverything() {
  while (undo.length > 0) await Promise.resolve(undo.pop()()).catch(() => undefined);
}

function browserPath() {
  if (process.env.CHROME) return process.env.CHROME;
  const installed = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => existsSync(path));
  if (installed) return installed;
  throw new Error("no browser found. Set CHROME to a Chromium-based browser's executable.");
}

/** Start the browser and answer its DevTools address, which it prints once it is listening. */
async function launch(profile) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // One CSS pixel is one image pixel, whatever the machine's display scale.
    "--force-device-scale-factor=1",
  ];
  if (process.env.CI) args.push("--no-sandbox");
  const child = spawn(browserPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
  undo.push(() => child.kill());
  let heard = "";
  return new Promise((found, lost) => {
    // A browser that could not be started at all — a `CHROME` naming nothing — says so here and
    // nowhere else: with no listener it is an uncaught `error` event and a stack, not a sentence.
    child.on("error", (error) => lost(new Error(`the browser did not start: ${error.message}`)));
    child.stderr.on("data", (chunk) => {
      heard += chunk;
      const hit = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (hit) found(hit[1]);
    });
    child.on("exit", (code) => lost(new Error(`the browser exited (${code}): ${heard}`)));
    setTimeout(() => lost(new Error(`the browser never listened: ${heard}`)), 30_000).unref();
  });
}

/** One socket to the browser; a page is a session on it. */
async function connect(address) {
  const socket = new WebSocket(address);
  await new Promise((opened, refused) => {
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", () => refused(new Error("no DevTools socket")), {
      once: true,
    });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, close: () => socket.close() };
}

/** The master mark as the drawing an icon wants: sized, scaled, and for a maskable one, grounded. */
function drawing(master, size, kind) {
  let svg = master.replace(/width="64" height="64"/, `width="${size}" height="${size}"`);
  if (kind === "plain") return svg;
  if (kind === "adaptive") return svg.replace(/scale\([\d.]+\)/, `scale(${ADAPTIVE_SCALE})`);
  svg = svg.replace(/scale\([\d.]+\)/, `scale(${MASKABLE_SCALE})`);
  return svg.replace("</defs>", `</defs><rect width="64" height="64" fill="${GROUND}"></rect>`);
}

/** The page a square icon is photographed on: the drawing and nothing else. */
function iconPage(master, size, kind) {
  return (
    `<!doctype html><html><body style="margin:0;overflow:hidden">` +
    drawing(master, size, kind).replace("<svg ", `<svg style="display:block" `) +
    `</body></html>`
  );
}

/** The store's banner: the mark alone on the ground, two thirds of the height, centred. */
function featurePage(master, width, height) {
  const mark = drawing(master, Math.round((height * 2) / 3), "plain").replace(
    "<svg ",
    `<svg style="display:block" `,
  );
  return (
    `<!doctype html><html><body style="margin:0;overflow:hidden;width:${width}px;` +
    `height:${height}px;background:${GROUND};display:flex;align-items:center;` +
    `justify-content:center">${mark}</body></html>`
  );
}

/**
 * The furthest painted pixel from the centre of `svg`, as a share of its width — asked of the
 * page, which rasterises the drawing onto a canvas and reads the alpha back.
 */
const measure = (svg, size) => `(async () => {
  const image = new Image();
  image.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ${size};
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, ${size}, ${size});
  const { data } = context.getImageData(0, 0, ${size}, ${size});
  let furthest = 0;
  for (let y = 0; y < ${size}; y++) {
    for (let x = 0; x < ${size}; x++) {
      if (data[(y * ${size} + x) * 4 + 3] < 16) continue;
      furthest = Math.max(furthest, Math.hypot(x + 0.5 - ${size} / 2, y + 0.5 - ${size} / 2));
    }
  }
  return furthest / ${size};
})()`;

async function main() {
  const master = await readFile(MARK, "utf8");
  if (!/width="64" height="64"/.test(master) || !/scale\([\d.]+\)/.test(master)) {
    throw new Error(`${MARK} is not shaped as this script reads it: a 64-unit mark with a scale.`);
  }

  const profile = await mkdtemp(join(tmpdir(), "grimoire-light-icons-"));
  undo.push(async () => {
    await pause(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const browser = await connect(await launch(profile));
  undo.push(() => browser.close());

  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => browser.send(method, params, sessionId);
  await page("Page.enable");
  await page("Runtime.enable");
  // Nothing behind the drawing: the transparent mark stays transparent in the PNG.
  await page("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

  // The safe zones, measured on the mark alone — a ground reaches every edge by design.
  const zones = [
    { kind: "maskable", safe: SAFE_RADIUS, knob: "MASKABLE_SCALE", what: "the maskable mark" },
    {
      kind: "adaptive",
      safe: ADAPTIVE_SAFE_RADIUS,
      knob: "ADAPTIVE_SCALE",
      what: "the launcher's foreground",
    },
  ];
  for (const { kind, safe, knob, what } of zones) {
    const alone = drawing(master, 512, kind).replace(/<rect width="64"[^>]*><\/rect>/, "");
    const { result } = await page("Runtime.evaluate", {
      expression: measure(alone, 512),
      awaitPromise: true,
      returnByValue: true,
    });
    const reach = result.value;
    if (!(reach > 0.2 && reach <= safe)) {
      throw new Error(
        `${what} reaches ${(reach * 100).toFixed(1)}% of the width from the centre; ` +
          `the safe zone is ${(safe * 100).toFixed(1)}%. Lower ${knob}.`,
      );
    }
    console.log(
      `ok  ${what} reaches ${(reach * 100).toFixed(1)}% — inside the ${(safe * 100).toFixed(1)}% circle`,
    );
  }

  for (const icon of ICONS) {
    const { dir, file, kind } = icon;
    const width = icon.width ?? icon.size;
    const height = icon.height ?? icon.size;
    await mkdir(dir, { recursive: true });
    await page("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const html =
      kind === "feature" ? featurePage(master, width, height) : iconPage(master, width, kind);
    await page("Page.navigate", {
      url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    });
    // Poll for the drawing rather than trusting a load event that may have fired already.
    for (let tries = 0; ; tries++) {
      const drawn = await page("Runtime.evaluate", {
        expression: `document.readyState === "complete" && !!document.querySelector("svg")`,
        returnByValue: true,
      });
      if (drawn.result.value === true) break;
      if (tries > 100) throw new Error(`${file}: the drawing never loaded`);
      await pause(50);
    }
    // A JPEG where the store takes no alpha; a PNG everywhere else, so a transparent mark stays so.
    const jpeg = file.endsWith(".jpg");
    const shot = await page("Page.captureScreenshot", {
      format: jpeg ? "jpeg" : "png",
      ...(jpeg ? { quality: 92 } : {}),
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    await writeFile(join(dir, file), Buffer.from(shot.data, "base64"));
    console.log(`ok  ${file} — ${width}×${height}, ${kind}`);
  }

  await mkdir(join(ANDROID_RES, "mipmap-anydpi-v26"), { recursive: true });
  await writeFile(join(ANDROID_RES, "mipmap-anydpi-v26", "ic_launcher.xml"), ADAPTIVE_XML);
  console.log("ok  mipmap-anydpi-v26/ic_launcher.xml — the adaptive icon");
}

main()
  .catch((error) => {
    console.error(`light-icons: FAILED — ${error.message}`);
    process.exitCode = 1;
  })
  .finally(stopEverything);
