#!/usr/bin/env node
// The light app's raster icons, rendered from the one master mark.
//
//     node scripts/light-icons.mjs
//
// A web manifest wants PNGs, and a maskable one besides: Android cuts an installed app's icon to
// whatever shape the launcher uses, and keeps only a circle 80% of its width whole. So there are
// two drawings here, both from `logos/svg/mtg-grimoire-mark.svg` and neither a file of its own —
// a third SVG beside the mark and the tile is a third thing to forget when the mark changes:
//
//   - **the mark**, transparent, as the desktop's icon is (`logos/README.md` has why the tile is
//     not the icon), at 192 and 512;
//   - **the maskable mark**, on the app's ground (`--color-bg`, `#0C0D12`) to every edge, drawn
//     small enough that the whole of it — clasp and ribbon too — is inside that circle.
//
// The renderer is a browser, because that is what this repository has: no image library is a
// dependency and none is added for four files. Headless Chromium over the DevTools protocol, as
// `web-smoke.mjs` drives it; `CHROME` names the browser, else the first of Chrome and Edge found
// installed. It writes `mobile/public/icons/`, which is committed — nothing runs this in a build.
//
// **It measures what it drew.** The maskable mark's scale is a number somebody chose, and the
// safe zone is a rule a number can break without anything looking wrong on a square preview. So
// the page reports the furthest painted pixel from the centre, and a mark that reaches past the
// circle fails the run instead of shipping.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MARK = resolve("logos/svg/mtg-grimoire-mark.svg");
const OUT = resolve("mobile/public/icons");

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

const ICONS = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "maskable-192.png", size: 192, maskable: true },
  { file: "maskable-512.png", size: 512, maskable: true },
];

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

/** The master mark as the drawing an icon wants: sized, and for a maskable one, grounded. */
function drawing(master, size, maskable) {
  let svg = master.replace(/width="64" height="64"/, `width="${size}" height="${size}"`);
  if (!maskable) return svg;
  svg = svg.replace(/scale\([\d.]+\)/, `scale(${MASKABLE_SCALE})`);
  return svg.replace("</defs>", `</defs><rect width="64" height="64" fill="${GROUND}"></rect>`);
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
  await mkdir(OUT, { recursive: true });

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

  // The safe zone, measured on the mark alone — the ground reaches every edge by design.
  const alone = drawing(master, 512, true).replace(/<rect width="64"[^>]*><\/rect>/, "");
  const { result } = await page("Runtime.evaluate", {
    expression: measure(alone, 512),
    awaitPromise: true,
    returnByValue: true,
  });
  const reach = result.value;
  if (!(reach > 0.2 && reach <= SAFE_RADIUS)) {
    throw new Error(
      `the maskable mark reaches ${(reach * 100).toFixed(1)}% of the width from the centre; ` +
        `the safe zone is ${SAFE_RADIUS * 100}%. Lower MASKABLE_SCALE.`,
    );
  }
  console.log(`ok  the maskable mark reaches ${(reach * 100).toFixed(1)}% — inside the 40% circle`);

  for (const { file, size, maskable } of ICONS) {
    await page("Emulation.setDeviceMetricsOverride", {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const html =
      `<!doctype html><html><body style="margin:0;overflow:hidden">` +
      drawing(master, size, maskable).replace("<svg ", `<svg style="display:block" `) +
      `</body></html>`;
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
    const shot = await page("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    });
    await writeFile(join(OUT, file), Buffer.from(shot.data, "base64"));
    console.log(`ok  ${file} — ${size}×${size}${maskable ? ", on the ground" : ", transparent"}`);
  }
}

main()
  .catch((error) => {
    console.error(`light-icons: FAILED — ${error.message}`);
    process.exitCode = 1;
  })
  .finally(stopEverything);
