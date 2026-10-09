#!/usr/bin/env node
// The web app's card scanner, in a real browser: **a camera shows a card, and the built app
// scans it** — the light app's step 7.5.
//
//     pnpm web:wasm && pnpm scanner:assets --web && pnpm web:build
//     pnpm web:scanner-smoke
//
// `pnpm web:smoke` proves the engine. This is the run that proves the *second* module: the
// scanner's own WASM, built with `simd128`, in a Worker of its own, fed the three files a reader
// downloads and the labels the engine hands across. Vitest drives the page's half over a fake
// Worker and cargo tests the module's logic natively; neither instantiates the module in a
// browser, moves a megabyte between two real Workers, or hears a real policy refuse something.
//
// It serves `apps/light/dist-web/` as the production host will (`web-smoke/harness.mjs`: every response
// under the headers `_headers` gives its address, a miss as the hosting Worker's own 404), on
// the **desktop face** — a 1440 × 900 viewport — in headless Chromium whose camera is a file:
// one real card on a table (`--use-file-for-fake-video-capture`). In this order:
//
//   1. the app opens and ingests a card file that has the card in it
//   2. the Scanner draws its offer — the three files, about 19 MB — and **nothing of the
//      scanner has left the host**: not its module, not one of its three files, and none of
//      them is in the service worker's shell. A frame sent meanwhile is refused in a sentence
//   3. Download fetches exactly the three files, once each, with progress the page hears
//      (`scanner:assets`: downloading, checking, done), and keeps them in Cache Storage under
//      their digests
//   4. the session builds — files out of the store, labels out of the engine's Worker — and
//      says so: bundle, labels and both readers loaded, from the store
//   5. **the card is recognised and lands in the tray**, by name
//   6. Add files it, and the Collection page draws it
//   7. sixty frames more are timed, one of them a read frame with its detail image, and the
//      module's memory is read
//   8. a fault staged in the scanner's Worker ends it; the frame in flight is refused in the
//      host's sentence, and the next frame is answered by a new Worker with a new session
//   9. leaving the Scanner ends the Worker: its DevTools target goes, and the host says there
//      is no session; asking again builds one, and that build is timed
//  10. **offline** — the server refusing every connection, every other host gone, the HTTP
//      cache emptied — a reload opens the Scanner and the card lands in the tray again. **The
//      one thing the page asks the host for is the scanner's manifest** (`scanner_assets` asks
//      it on every visit, past every cache, to learn whether a newer bundle is owed); it is
//      refused, nothing is owed that the store does not hold, and no offer is drawn. The
//      browser asks for `sw.js`, as every load does. Nothing else is asked — not the module,
//      not a file, not a chunk of the app's own shell
//  11. the host's Content-Security-Policy refused nothing, in the page, in either dedicated
//      Worker or in the service worker; no request went to a host with no fixture
//
//  12. **the phone face**, in a browser and a profile of its own at 360 × 800 under the same
//      camera: a first run again, the offer drawn in the phone page's slot under its camera
//      with nothing scrolling sideways, Download, the card in the tray, Add, and an empty tray
//
// **The card's picture is not in this repository** — card image bytes never are — so it is the
// one thing this run brings from outside: `SCAN_CARD_PICTURE=<file>` when that is set, else the
// card's `large` scan from Scryfall's CDN, fetched by this script (never by the browser, whose
// resolver knows no name but `localhost`) under the app's own `User-Agent`, tried three times,
// and kept — in `SCAN_CARD_CACHE` when that names a folder, which CI caches between runs, else
// in the system's temp folder. A picture that cannot be had after that fails the run: a skip
// would be a run that passed having scanned nothing. A second
// headless browser decodes it and lays it on a table — a browser is the JPEG decoder this
// script does not have — and the frame is written as Y4M **with its chroma**: the scanner's
// hash reads colour, and a grey card matches nothing.
//
// **The staged fault is a message, not a panic.** No export of the module panics on request —
// a callable trap would ship to every reader — and its clock swallows a throwing
// `performance.now`. So step 8 has the Worker *say* it trapped (`scanProtocol.ts`'s `trapped`),
// from inside the Worker, over DevTools: what is real from there on is everything the page
// does about it. A real panic in this module, in a browser, has still not been seen.
//
// Dependency-free, on the harness the other two web smokes use.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import {
  ALERT,
  DIST,
  FIXTURES,
  browse,
  buttonSaying,
  connect,
  discard,
  fail,
  fixtures,
  launch,
  openPage,
  pause,
  runAs,
  serve,
  undo,
} from "./web-smoke/harness.mjs";

const DEADLINE_MS = 300_000;
/** A phone: under the app's 1024px floor, and the narrowest the phone face is measured at. */
const PHONE = [360, 800];
/** The desktop face: at or past the app's 1024px floor. */
const VIEW = [1440, 900];
/** The camera's frame: 720p, the least the readers are given a detail image at. */
const FRAME = [1280, 720];
/** The card's height in that frame — most of it, as a reader holds one. */
const CARD_HEIGHT = 640;
/** A play mat, not a black table: this card's border is black, and an edge needs two sides. */
const TABLE = "#6b5a3e";

/** The card the camera shows — Counterspell, Modern Horizons 2 #267 — as Scryfall describes it. */
const CARD = JSON.parse(readFileSync(join(FIXTURES, "scan-card.json"), "utf8"));

const SCANNER_CACHE = "grimoire-scanner-v1";
const SHELL_PREFIX = "grimoire-shell-";
const ASSETS = ["card-hashes.bin", "text-detection.rten", "text-recognition.rten"];
/** The page's sentences this run reads (`packages/ui/lib/core/web/scanner.ts`). */
const NOT_DOWNLOADED = "The scanner's card data has not been downloaded yet.";
const STOPPED = "The card scanner stopped unexpectedly. It starts again with the next frame.";

const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const ms = (n) => `${Math.round(n)} ms`;

// ---------------------------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------------------------

/** The app's `User-Agent`, as the engine spells it to Scryfall (`scryfall::USER_AGENT`). */
const USER_AGENT = `MTGGrimoire/${JSON.parse(readFileSync("package.json", "utf8")).version} (https://github.com/Msgaihede/mtg-grimoire)`;

/** The card's picture, as bytes a browser can decode. */
async function cardPicture() {
  const named = process.env.SCAN_CARD_PICTURE;
  if (named) {
    if (!existsSync(named)) fail(`SCAN_CARD_PICTURE names ${named}, which is not there.`);
    return readFileSync(named);
  }
  const folder = process.env.SCAN_CARD_CACHE || tmpdir();
  mkdirSync(folder, { recursive: true });
  const kept = join(folder, `grimoire-scan-card-${CARD.id}.jpg`);
  if (existsSync(kept) && statSync(kept).size > 10_000) return readFileSync(kept);
  const address = CARD.image_uris.large;
  // Three tries, a few seconds apart: one dropped connection to a CDN is not a red build.
  let why = "";
  for (const wait of [0, 3_000, 9_000]) {
    await pause(wait);
    try {
      const response = await fetch(address, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        why = `it answered ${response.status}`;
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 10_000) {
        why = `it answered ${bytes.length} bytes, which is no card`;
        continue;
      }
      writeFileSync(kept, bytes);
      return bytes;
    } catch (error) {
      why = error.cause?.message ?? error.message;
    }
  }
  return fail(
    `the card's picture could not be fetched from ${address} in three tries: ${why}. ` +
      "Set SCAN_CARD_PICTURE to a picture of Counterspell (MH2 267) to run without Scryfall.",
  );
}

/** A frame's RGBA as planar YUV 4:2:0, full range (BT.601 — what `C420jpeg` says it is). */
function yuv(rgba, width, height) {
  const luma = Buffer.alloc(width * height);
  const u = Buffer.alloc((width / 2) * (height / 2));
  const v = Buffer.alloc((width / 2) * (height / 2));
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let cb = 0;
      let cr = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const at = ((y + dy) * width + x + dx) * 4;
        const [r, g, b] = [rgba[at], rgba[at + 1], rgba[at + 2]];
        luma[(y + dy) * width + x + dx] = clamp(0.299 * r + 0.587 * g + 0.114 * b);
        cb += -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
        cr += 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      }
      u[(y / 2) * (width / 2) + x / 2] = clamp(cb / 4);
      v[(y / 2) * (width / 2) + x / 2] = clamp(cr / 4);
    }
  }
  return Buffer.concat([luma, u, v]);
}

/**
 * The file the browser's camera plays: the card, face on, on a table. Composed by a headless
 * browser of its own — it is closed before the run's browser starts — and written as a few
 * frames of uncompressed video, which Chromium loops.
 */
async function cameraFile(scratch) {
  const picture = await cardPicture();
  const profile = await mkdtemp(join(tmpdir(), "grimoire-scan-camera-"));
  const { address, kill } = await launch(profile);
  const browser = await connect(address);
  const [width, height] = FRAME;
  let rgba;
  try {
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    const { result, exceptionDetails } = await browser.send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const bytes = Uint8Array.from(atob(${JSON.stringify(picture.toString("base64"))}), (c) => c.charCodeAt(0));
          const card = await createImageBitmap(new Blob([bytes]));
          const canvas = new OffscreenCanvas(${width}, ${height});
          const g = canvas.getContext("2d");
          g.fillStyle = ${JSON.stringify(TABLE)};
          g.fillRect(0, 0, ${width}, ${height});
          const h = ${CARD_HEIGHT};
          const w = Math.round((h * card.width) / card.height);
          const x = (${width} - w) / 2;
          const y = (${height} - h) / 2;
          // A scan's corners are white outside the card's own rounded ones; on a table there
          // is table there.
          g.beginPath();
          g.roundRect(x, y, w, h, w * 0.045);
          g.clip();
          g.imageSmoothingQuality = "high";
          g.drawImage(card, x, y, w, h);
          const rgba = g.getImageData(0, 0, ${width}, ${height}).data;
          let text = "";
          for (let at = 0; at < rgba.length; at += 0x8000) {
            text += String.fromCharCode.apply(null, rgba.subarray(at, at + 0x8000));
          }
          globalThis.__frame = btoa(text);
          return { length: globalThis.__frame.length, card: [card.width, card.height] };
        })()`,
      },
      sessionId,
    );
    if (exceptionDetails) fail(`the card's picture would not decode: ${exceptionDetails.exception?.description}`);
    // A megabyte at a time: one DevTools message of the whole frame — five megabytes of
    // base64 — never arrives (measured, Chrome 154 and Node 24's WebSocket: 2 MB does, 5 MB
    // does not).
    let text = "";
    for (let at = 0; at < result.value.length; at += 1_000_000) {
      const slice = await browser.send(
        "Runtime.evaluate",
        { expression: `globalThis.__frame.slice(${at}, ${at + 1_000_000})`, returnByValue: true },
        sessionId,
      );
      text += slice.result.value;
    }
    rgba = Buffer.from(text, "base64");
    console.log(`    the card's picture is ${result.value.card.join(" × ")}, shown ${CARD_HEIGHT}px tall in a ${width} × ${height} frame`);
  } finally {
    browser.close();
    kill();
    await pause(500);
    await discard(profile);
  }
  const one = Buffer.concat([Buffer.from("FRAME\n"), yuv(rgba, width, height)]);
  const path = join(scratch, "card.y4m");
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`),
      ...Array.from({ length: 6 }, () => one),
    ]),
  );
  return path;
}

// ---------------------------------------------------------------------------------------------
// What the page is asked
// ---------------------------------------------------------------------------------------------

/** The page's `Core` with the scanner in front of it — `scanner.ts`'s module singleton. */
function scannerChunk() {
  const name = readdirSync(join(DIST, "assets")).find((file) => /^scanner-[\w-]+\.js$/.test(file));
  if (!name) fail("apps/light/dist-web/assets has no scanner-*.js chunk — the page's scanner moved.");
  return `/assets/${name}`;
}

const OFFER = `document.querySelector('section[aria-label="Scanner files"]')`;
const ADD = `[...document.querySelectorAll("button")].find((b) => /^Add \\d+ to collection/.test(b.innerText.trim()))`;
/** A row of the desktop shell's sidebar, by its word. */
const sidebar = (word) =>
  `[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(word)})`;
/** Every cache this origin has, and the paths each holds. */
const CACHES = `(async () => {
  const held = {};
  for (const name of await caches.keys()) {
    held[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  }
  return held;
})()`;

/** One frame of the page's own video as JPEG bytes, `width` wide, in the page: an expression. */
const grab = (width) => `(async () => {
  const video = document.querySelector("video");
  const scale = ${width} / video.videoWidth;
  const canvas = new OffscreenCanvas(${width}, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return new Uint8Array(await blob.arrayBuffer());
})()`;

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/**
 * **The phone face**, on a profile of its own — so a first run, with nothing of the scanner in
 * the store and an empty tray: a tray row the desktop leg left would make "the card is in the
 * tray" true before a frame was sent.
 */
async function phoneFace(origin, site, routes, camera, chunk) {
  const { browser, hosts, policy, close } = await browse(origin, routes, {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${camera}`,
    ],
  });
  const phone = (sessionId) =>
    browser.send(
      "Emulation.setDeviceMetricsOverride",
      { width: PHONE[0], height: PHONE[1], deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  const page = await openPage(browser, `${origin}/search`, hosts.check, policy, phone);
  const engine = async (command, args) => {
    const answer = await page.evaluate(
      `import(${JSON.stringify(chunk)})
        .then((module) => module.scanningCore.call(${JSON.stringify(command)}, ${JSON.stringify(args)}))
        .then((value) => ({ value }), (refused) => ({ refused: String(refused) }))`,
    );
    if (answer.refused !== undefined) fail(`on the phone face, ${command} was refused: ${answer.refused}`);
    return answer.value;
  };
  const TABS = `document.querySelector('nav[aria-label="Views"]')`;
  await page.until("the phone face got past its startup gate", `!!${TABS} || ${ALERT}`);
  const refusedOpen = await page.evaluate(ALERT);
  if (refusedOpen) fail(`on the phone face the app did not open its database:\n${refusedOpen}`);
  await page.until(
    "the service worker took the phone's page",
    `navigator.serviceWorker.controller?.state === "activated"`,
    60_000,
  );
  for (const stop = performance.now() + 60_000; ; await pause(250)) {
    hosts.check();
    const sync = await engine("sync_status");
    if (sync.cardCount === 7 && !sync.syncing) break;
    if (performance.now() > stop) fail(`on the phone face the card sync never finished: ${JSON.stringify(sync)}`);
  }
  const prefs = await engine("scanner_prefs");
  await engine("set_scanner_prefs", { prefs: { ...prefs, finish: "nonfoil" } });
  const before = site.asked.length;

  await page.press("the Scanner tab", `${TABS}.querySelector('a[href="/scanner"]')`);
  await page.until("the phone's Scanner drew its offer", `!!${OFFER} && !!${buttonSaying("Download", 'section[aria-label="Scanner files"]')}`);
  const offer = await page.evaluate(`${OFFER}.innerText`);
  if (!/about 19 MB/.test(offer)) fail(`the phone's offer does not say what it costs:\n${offer}`);
  const sideways = () =>
    page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  const box = await page.evaluate(`(() => { const r = ${OFFER}.getBoundingClientRect(); return [r.left, r.right, innerWidth]; })()`);
  if (box[0] < 0 || box[1] > box[2] || (await sideways()) > 0) {
    fail(`at ${PHONE[0]}px the offer runs off the screen: ${JSON.stringify(box)}, ${await sideways()}px sideways`);
  }
  if (await page.evaluate(`!!${ADD} && !/^Add 0 /.test(${ADD}.innerText.trim())`)) {
    fail("the phone's tray held a card before a frame was sent");
  }
  const early = site.asked
    .slice(before)
    .filter((path) => /^\/wasm\/[^/]+\/scanner\//.test(path) || (path.startsWith("/scanner-assets/") && !path.endsWith("manifest.json")));
  if (early.length > 0) fail(`on the phone face the scanner's files were asked for before the press: ${early.join(", ")}`);

  await page.press("Download", buttonSaying("Download", 'section[aria-label="Scanner files"]'));
  await page.until("on the phone face, the files landed and the offer went", `!${OFFER}`, 120_000);
  await page.until(
    "on the phone face, the card was recognised and landed in the tray",
    `!!${ADD} && /^Add 1 to collection$/.test(${ADD}.innerText.trim())`,
    60_000,
  );
  if ((await sideways()) > 0) fail(`with a card in the tray the phone's Scanner scrolls ${await sideways()}px sideways`);
  await page.press("Add", ADD);
  await page.until("on the phone face, the tray was filed", `!${ADD} || !/^Add 1 /.test(${ADD}.innerText.trim())`, 30_000);
  hosts.check();
  const thrown = page.thrown();
  if (thrown.length > 0) fail(`the phone's page threw:\n${thrown.join("\n")}`);
  console.log(
    `ok  on the phone face at ${PHONE[0]}px: the offer in the page's slot, Download, ${CARD.name} in the tray and filed, ` +
      "nothing scrolling sideways and the policy refusing nothing",
  );
  await close();
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "grimoire-scan-smoke-"));
  undo.push(() => discard(scratch));
  const camera = await cameraFile(scratch);

  const { origin, site } = await serve();
  const chunk = scannerChunk();
  // The committed six cards and the one the camera shows: its label is the engine's to give.
  const cardFile = Buffer.concat([
    readFileSync(join(FIXTURES, "default-cards.jsonl")),
    Buffer.from(`${JSON.stringify(CARD)}\n`),
  ]);
  const routes = fixtures(cardFile);
  const picture = {
    body: readFileSync(join(FIXTURES, "card.webp")),
    headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000" },
  };
  for (const variant of ["thumb", "grid", "display", "art"]) routes.set(CARD.image_uris[variant], picture);

  const { browser, hosts, policy, close } = await browse(origin, routes, {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${camera}`,
    ],
  });
  const desktop = (sessionId) =>
    browser.send(
      "Emulation.setDeviceMetricsOverride",
      { width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  const page = await openPage(browser, `${origin}/search`, hosts.check, policy, desktop);

  /** One call through the page's scanning `Core`. `args` is JSON, or an expression for bytes. */
  const call = async (command, args, options) => {
    const answer = await page.evaluate(
      `import(${JSON.stringify(chunk)})
        .then(async (module) => module.scanningCore.call(${JSON.stringify(command)}, ${
          typeof args === "string" ? `await ${args}` : JSON.stringify(args)
        }, ${JSON.stringify(options)}))
        .then((value) => ({ value }), (refused) => ({ refused: String(refused) }))`,
    );
    return answer;
  };
  const engine = async (command, args, options) => {
    const answer = await call(command, args, options);
    if (answer.refused !== undefined) fail(`${command} was refused: ${answer.refused}`);
    return answer.value;
  };
  /** Paths the server has been asked for that are the scanner's: its module, or its files. */
  const scannerAsks = () =>
    site.asked.filter((path) => /^\/wasm\/[^/]+\/scanner\//.test(path) || path.startsWith("/scanner-assets/"));

  // ---- 1. the app, with the card in its corpus ----------------------------------------------
  await page.until("the desktop face got past its startup gate", `!!${sidebar("Scanner")} || ${ALERT}`);
  const refusedOpen = await page.evaluate(ALERT);
  if (refusedOpen) fail(`the app did not open its database:\n${refusedOpen}`);
  await page.until(
    "the service worker took the page",
    `navigator.serviceWorker.controller?.state === "activated"`,
    60_000,
  );
  for (const stop = performance.now() + 60_000; ; await pause(250)) {
    hosts.check();
    const sync = await engine("sync_status");
    if (sync.cardCount === 7 && !sync.syncing) break;
    if (performance.now() > stop) fail(`the card sync never finished: ${JSON.stringify(sync)}`);
  }
  console.log("ok  the app opened on the desktop face and ingested 7 cards, the camera's among them");

  // The finish is the reader's to fix for this run: at this size the collector line's mark is
  // a few pixels, and a row with an unknown finish is one Add leaves in the tray.
  const prefs = await engine("scanner_prefs");
  await engine("set_scanner_prefs", { prefs: { ...prefs, finish: "nonfoil" } });
  await page.evaluate(
    `import(${JSON.stringify(chunk)}).then((module) => {
      globalThis.__assets = [];
      module.scanningCore.listen("scanner:assets", (event) => globalThis.__assets.push(event));
    })`,
  );

  // ---- 2. the offer, and nothing fetched ------------------------------------------------------
  await page.press("the sidebar's Scanner", sidebar("Scanner"));
  await page.until("the Scanner drew its offer", `!!${OFFER} && !!${buttonSaying("Download", 'section[aria-label="Scanner files"]')}`);
  const offer = await page.evaluate(`${OFFER}.innerText`);
  if (!/about 19 MB/.test(offer) || !/Card hashes/.test(offer) || !/Text recognition model/.test(offer)) {
    fail(`the offer does not say what it costs:\n${offer}`);
  }
  await page.until("a frame was refused for want of the files", `document.body.innerText.includes(${JSON.stringify(NOT_DOWNLOADED)})`, 30_000);
  const early = scannerAsks().filter((path) => path !== "/scanner-assets/manifest.json");
  if (early.length > 0) fail(`the scanner's files were asked for before the press: ${early.join(", ")}`);
  const before = await page.evaluate(CACHES);
  const inShell = Object.entries(before)
    .filter(([name]) => name.startsWith(SHELL_PREFIX))
    .flatMap(([, paths]) => paths)
    .filter((path) => /\/scanner\/|^\/scanner-assets\//.test(path));
  if (inShell.length > 0) fail(`the service worker precached the scanner's files: ${inShell.join(", ")}`);
  if (before[SCANNER_CACHE]?.length) fail(`the scanner's cache holds something already: ${before[SCANNER_CACHE]}`);
  if (policy.workerScripts().some(([, url]) => url.includes("scanWorker"))) {
    fail("a scanner Worker was started before there was anything to load");
  }
  console.log(`ok  the Scanner offers its files (${offer.split("\n")[0]}) and has fetched none: no module, no Worker, nothing in the shell`);

  // ---- 3. the download ------------------------------------------------------------------------
  const pressed = performance.now();
  await page.press("Download", buttonSaying("Download", 'section[aria-label="Scanner files"]'));
  await page.until("the files landed and the offer went", `!${OFFER}`, 120_000);
  const heard = await page.evaluate("globalThis.__assets");
  const phases = new Set(heard.map((event) => event.phase));
  const total = ASSETS.reduce((sum, name) => sum + statSync(join(DIST, "scanner-assets", name)).size, 0);
  if (!["downloading", "checking", "done"].every((phase) => phases.has(phase)) || phases.has("error")) {
    fail(`the fetch's progress was ${JSON.stringify([...phases])}: ${JSON.stringify(heard.at(-1))}`);
  }
  if (heard.at(-1).done !== total || heard.at(-1).total !== total) {
    fail(`the fetch ended on ${JSON.stringify(heard.at(-1))}, and the three files are ${total} bytes`);
  }
  for (const name of ASSETS) {
    const asks = site.asked.filter((path) => path === `/scanner-assets/${name}`).length;
    if (asks !== 1) fail(`${name} was asked for ${asks} times`);
  }
  console.log(
    `ok  Download fetched the three files once each — ${mb(total)}, ${heard.length} progress events, ` +
      `${ms(performance.now() - pressed)} from the press to the offer going`,
  );

  // ---- 4. the session -------------------------------------------------------------------------
  const status = await engine("scanner_status");
  const loaded =
    status.bundle.loaded && status.bundle.error === null && status.detection_model.loaded &&
    status.recognition_model.loaded && status.labels > 0 && status.bundle.source === "store";
  if (!loaded) fail(`the session did not load everything:\n${JSON.stringify(status, null, 2)}`);
  const kept = (await page.evaluate(CACHES))[SCANNER_CACHE] ?? [];
  const wanted = [
    ...ASSETS.map((name) => `/scanner-assets/${name}`),
    ...new Set(site.asked.filter((path) => /^\/wasm\/[^/]+\/scanner\//.test(path))),
  ];
  const lost = wanted.filter((path) => !kept.includes(path));
  if (wanted.length !== 5 || lost.length > 0) {
    fail(`the scanner's cache holds ${JSON.stringify(kept)}; it should hold ${JSON.stringify(wanted)}`);
  }
  console.log(`ok  the session built: bundle, ${status.labels} labels and both readers, from the store; the module and the files are kept`);

  // ---- 5. the card ------------------------------------------------------------------------------
  await page.until(
    "the card was recognised and landed in the tray",
    `!!${ADD} && /^Add 1 to collection$/.test(${ADD}.innerText.trim()) && document.body.innerText.includes(${JSON.stringify(CARD.name)})`,
    60_000,
  );
  console.log(`ok  ${CARD.name} was recognised and is in the tray (${ms(performance.now() - pressed)} after the press)`);

  // ---- 6. the commit ----------------------------------------------------------------------------
  await page.press("Add", ADD);
  await page.until("the tray was filed", `!${ADD} || !/^Add 1 /.test(${ADD}.innerText.trim())`, 30_000);

  // ---- 7. sixty frames, timed ---------------------------------------------------------------------
  await page.press("Stop scanning", buttonSaying("Stop scanning"));
  await pause(1500);
  await engine("scanner_reset");
  const options = { headers: { "x-scanner-options": JSON.stringify({ mode: "fast" }) } };
  const timed = await page.evaluate(`(async () => {
    const { scanningCore } = await import(${JSON.stringify(chunk)});
    const small = () => ${grab(640)};
    const large = () => ${grab(FRAME[0])};
    const plain = [];
    const reads = [];
    let named = null;
    let asks = false;
    for (let i = 0; i < 60; i += 1) {
      const jpeg = await small();
      let body = jpeg;
      const headers = { ...${JSON.stringify(options.headers)} };
      if (asks) {
        const detail = await large();
        body = new Uint8Array(jpeg.length + detail.length);
        body.set(jpeg, 0);
        body.set(detail, jpeg.length);
        headers["x-scanner-detail"] = String(jpeg.length);
      }
      const read = asks;
      const t0 = performance.now();
      const verdict = await scanningCore.call("scanner_frame", body, { headers });
      (read ? reads : plain).push(performance.now() - t0);
      asks = verdict.wants_detail === true;
      named = verdict.decision?.label?.name ?? named;
    }
    const memory = await scanningCore.call("host:scanner_memory");
    return { plain, reads, named, memory };
  })()`);
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  if (timed.plain.length === 0 || timed.memory === null) fail(`no frame was timed: ${JSON.stringify(timed)}`);
  console.log(
    `ok  60 frames: ${timed.plain.length} plain at a median ${ms(median(timed.plain))} (max ${ms(Math.max(...timed.plain))}), ` +
      `${timed.reads.length} read frame(s)${timed.reads.length ? ` at a median ${ms(median(timed.reads))} (max ${ms(Math.max(...timed.reads))})` : ""}; ` +
      `the module's memory stands at ${mb(timed.memory)}; decided: ${timed.named ?? "nothing"}`,
  );

  // ---- 8. a staged fault ------------------------------------------------------------------------
  const scanners = () => policy.workerScripts().filter(([, url]) => url.includes("scanWorker"));
  const gone = (sessionId) =>
    browser.heard.some((m) => m.method === "Target.detachedFromTarget" && m.params.sessionId === sessionId);
  const [first] = scanners().filter(([id]) => !gone(id)).slice(-1);
  if (!first) fail("there is no scanner Worker to stage a fault in");
  const refused = page.evaluate(`(async () => {
    const { scanningCore } = await import(${JSON.stringify(chunk)});
    const jpeg = await ${grab(640)};
    return scanningCore.call("scanner_frame", jpeg, ${JSON.stringify(options)}).then(() => null, String);
  })()`);
  // Under the frame, or just behind it: either way the Worker has said it trapped.
  await browser.send(
    "Runtime.evaluate",
    { expression: `self.postMessage({ kind: "trapped", id: 0, message: "staged by the smoke run" })` },
    first[0],
  );
  const sentence = await refused;
  if (sentence !== null && sentence !== STOPPED) fail(`the frame under the fault was refused with ${JSON.stringify(sentence)}`);
  for (const stop = performance.now() + 15_000; !gone(first[0]); await pause(100)) {
    if (performance.now() > stop) fail("the Worker that trapped was not ended");
  }
  const after = await call("scanner_frame", grab(640), options);
  if (after.refused !== undefined || after.value.ok !== true) {
    fail(`the frame after the fault was not answered: ${JSON.stringify(after).slice(0, 400)}`);
  }
  const [second] = scanners().filter(([id]) => !gone(id)).slice(-1);
  if (!second || second[0] === first[0]) fail("the frame after the fault was not answered by a new Worker");
  console.log(
    `ok  a staged fault ended the scanner's Worker${sentence === null ? "" : `, the frame in flight was refused ("${sentence}")`}, ` +
      "and the next frame was answered by a new one",
  );

  // ---- 9. leaving the Scanner -------------------------------------------------------------------
  await page.press("the sidebar's Collection", sidebar("Collection"));
  // The wall draws a picture and its printing, not the name: the tile is named for the card.
  await page.until(
    `the Collection drew ${CARD.name}`,
    `!!document.querySelector('[aria-label*=${JSON.stringify(CARD.name)}]') &&
      document.body.innerText.includes("1 in your collection")`,
    30_000,
  );
  console.log(`ok  Add filed it: the Collection page draws ${CARD.name}`);
  const left = performance.now();
  for (const stop = left + 40_000; !gone(second[0]); await pause(250)) {
    hosts.check();
    if (performance.now() > stop) fail("the scanner's Worker was still alive 40 s after the Scanner was left");
  }
  const idle = performance.now() - left;
  if ((await engine("host:scanner_memory")) !== null) fail("the host still answers for a session after its Worker went");
  const t0 = performance.now();
  const rebuilt = await engine("scanner_status");
  const build = performance.now() - t0;
  if (!rebuilt.bundle.loaded || rebuilt.labels !== status.labels) fail(`the session built again differently: ${JSON.stringify(rebuilt)}`);
  const fresh = await engine("host:scanner_memory");
  console.log(
    `ok  leaving the Scanner ended its Worker after ${ms(idle)}; a new session built in ${ms(build)} ` +
      `(the store, the labels, the module from the service worker's cache) at ${mb(fresh)}`,
  );

  // ---- 10. offline --------------------------------------------------------------------------------
  const asked = site.asked.length;
  const fixtureAsks = hosts.asked.length;
  site.refusing = true;
  hosts.offline(true);
  await page.forget();
  await page.evaluate(`location.assign("/scanner")`);
  await page.until("offline, the Scanner opened again", `!!${buttonSaying("Stop scanning")} || ${ALERT}`, 60_000);
  const refusedOffline = await page.evaluate(ALERT);
  if (refusedOffline) fail(`offline, the app did not open:\n${refusedOffline}`);
  await page.until(
    "offline, the card was recognised and landed in the tray",
    `!!${ADD} && /^Add 1 /.test(${ADD}.innerText.trim()) && document.body.innerText.includes(${JSON.stringify(CARD.name)})`,
    60_000,
  );
  if (await page.evaluate(`!!${OFFER}`)) fail("offline, the Scanner offers a download it cannot make");
  // What was asked of a host that was not there: the scanner's manifest by the page, the
  // worker's own script by the browser — a load asks whether there is a newer one — and
  // nothing else.
  const offlineAsks = [...new Set(site.asked.slice(asked))];
  const beyond = offlineAsks.filter((path) => path !== "/scanner-assets/manifest.json" && path !== "/sw.js");
  if (beyond.length > 0) fail(`offline, the server was asked for ${beyond.join(", ")}`);
  if (!offlineAsks.includes("/scanner-assets/manifest.json")) {
    fail("offline, the page never asked whether its scanner's files are current");
  }
  const offlineStatus = await engine("scanner_status");
  if (!offlineStatus.bundle.loaded || !offlineStatus.detection_model.loaded) {
    fail(`offline, the session is ${JSON.stringify(offlineStatus)}`);
  }
  console.log(
    `ok  offline — the host refusing every connection, the HTTP cache emptied — a reload opened the Scanner ` +
      `and ${CARD.name} landed in the tray again; the host was asked for ${offlineAsks.join(" and ")} ` +
      `and nothing else (${hosts.asked.length - fixtureAsks} asks of other hosts, each failed)`,
  );
  site.refusing = false;
  hosts.offline(false);

  // ---- 11. the policy, and what crossed the wire ---------------------------------------------------
  hosts.check();
  const thrown = page.thrown();
  if (thrown.length > 0) fail(`the page threw:\n${thrown.join("\n")}`);
  const watched = policy.watched();
  for (const kind of ["worker-", "scanWorker-", "sw.js"]) {
    if (!watched.some((name) => name.includes(kind))) fail(`the policy was never listened to on ${kind}: ${watched}`);
  }
  console.log(`ok  the Content-Security-Policy refused nothing, on ${watched.length} targets — the page, both Workers and the service worker`);

  await close();
  await phoneFace(origin, site, routes, camera, chunk);

  const brotli = (path) =>
    brotliCompressSync(readFileSync(path), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
  const scannerDir = readdirSync(join(DIST, "wasm"))
    .map((id) => join(DIST, "wasm", id, "scanner"))
    .find((dir) => existsSync(dir));
  const files = [
    ...readdirSync(scannerDir).map((name) => join(scannerDir, name)),
    ...ASSETS.map((name) => join(DIST, "scanner-assets", name)),
  ];
  console.log("    what a first scan fetches, as this server sent it (identity) and through brotli at level 5:");
  for (const path of files) {
    console.log(`      ${path.slice(DIST.length + 1).replaceAll("\\", "/")}  ${statSync(path).size} B  ${brotli(path)} B`);
  }
}

runAs("web:scanner-smoke", DEADLINE_MS, main);
