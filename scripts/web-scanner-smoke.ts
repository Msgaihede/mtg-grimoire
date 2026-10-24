#!/usr/bin/env node
// The web app's card scanner, in a real browser: **a camera shows a card, and the built app
// scans it** — the light app's step 7.5.
//
//     pnpm web:wasm && pnpm web:build
//     pnpm web:scanner-smoke
//
// `pnpm web:smoke` proves the engine. This is the run that proves the *second* module: the
// scanner's own WASM, built with `simd128`, in a Worker of its own, handed the Neural scanner's
// files from the app's origin (`/scanner-neural/<set>/`) and the labels the engine hands across.
// Vitest drives the page's half over a fake Worker and cargo tests the module's logic natively;
// neither instantiates the module in a browser, moves megabytes between two real Workers, or
// hears a real policy refuse something.
//
// It serves `apps/light/dist-web/` as the production host will (`web-smoke/harness.ts`: every response
// under the headers `_headers` gives its address, a miss as the hosting Worker's own 404), on
// the **desktop face** — a 1440 × 900 viewport — in headless Chromium whose camera is a file:
// one real card on a table (`--use-file-for-fake-video-capture`). In this order:
//
//   1. the app opens and ingests a card file that has the card in it
//   2. the Scanner opens stopped, and **none of the Neural scanner's files has left the host**,
//      and none of the scanner's is in the service worker's shell
//   3. Start scanning: the Neural files are fetched, once each, **the card is recognised and
//      lands in the tray**, by name
//   4. the session says so — the Neural files and the labels loaded — and the service worker
//      keeps the module and the files in the scanner's Cache Storage
//   5. Add files it, and the Collection page draws it
//   6. sixty frames more are timed, and the module's memory is read
//   7. a fault staged in the scanner's Worker ends it; the frame in flight is refused in the
//      host's sentence, and the next frame is answered by a new Worker with a new session
//   8. leaving the Scanner ends the Worker: its DevTools target goes, and the host says there
//      is no session; asking again builds one, and that build is timed
//   9. **offline** — the server refusing every connection, every other host gone, the HTTP
//      cache emptied — a reload opens the Scanner and the card lands in the tray again. The
//      browser asks for `sw.js`, as every load does. Nothing else is asked — not the module,
//      not a file, not a chunk of the app's own shell
//  10. the host's Content-Security-Policy refused nothing, in the page, in either dedicated
//      Worker or in the service worker; no request went to a host with no fixture
//
//  11. **the phone face**, in a browser and a profile of its own at 360 × 800 under the same
//      camera: a first run again, Start scanning, the card in the tray with nothing scrolling
//      sideways, Add, and an empty tray
//
// **The card's picture is not in this repository** — card image bytes never are — so it is the
// one thing this run brings from outside: `SCAN_CARD_PICTURE=<file>` when that is set, else the
// card's `large` scan from Scryfall's CDN, fetched by this script (never by the browser, whose
// resolver knows no name but `localhost`) under the app's own `User-Agent`, tried three times,
// and kept — in `SCAN_CARD_CACHE` when that names a folder, which CI caches between runs, else
// in the system's temp folder. A picture that cannot be had after that fails the run: a skip
// would be a run that passed having scanned nothing. A second
// headless browser decodes it and lays it on a table — a browser is the JPEG decoder this
// script does not have — and the frame is written as Y4M **with its chroma**: the recogniser
// reads colour, and a grey card is not the card.
//
// **The staged fault is a message, not a panic.** No export of the module panics on request —
// a callable trap would ship to every reader — and its clock swallows a throwing
// `performance.now`. So step 7 has the Worker *say* it trapped (`scanProtocol.ts`'s `trapped`),
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
} from "./web-smoke/harness.ts";

import type { Site } from "./web-smoke/harness.ts";
type ScanStatus = {
  neural: { loaded: boolean; error: string | null; source: string };
  labels: number;
};
type ScanResults = {
  sync_status: { cardCount: number; syncing: boolean };
  scanner_prefs: Record<string, unknown>;
  set_scanner_prefs: unknown;
  scanner_status: ScanStatus;
  scanner_reset: unknown;
  scanner_frame: { ok: boolean };
  "host:scanner_memory": number | null;
};
const DEADLINE_MS = 300_000;
/** A phone: under the app's 1024px floor, and the narrowest the phone face is measured at. */
const PHONE = [360, 800];
/** The desktop face: at or past the app's 1024px floor. */
const VIEW = [1440, 900];
/** The camera's frame: 720p, as a laptop's camera gives one. */
const FRAME = [1280, 720];
/** The card's height in that frame — most of it, as a reader holds one. */
const CARD_HEIGHT = 640;
/** A play mat, not a black table: this card's border is black. */
const TABLE = "#6b5a3e";

/** The card the camera shows — Counterspell, Modern Horizons 2 #267 — as Scryfall describes it. */
const CARD: { id: string; name: string; image_uris: Record<string, string> } = JSON.parse(
  readFileSync(join(FIXTURES, "scan-card.json"), "utf8"),
);

const SCANNER_CACHE = "grimoire-scanner-v1";
const SHELL_PREFIX = "grimoire-shell-";
/** Where the build serves the Neural scanner's files: `/scanner-neural/<set>/<name>` (`assets.ts`). */
const NEURAL_PREFIX = "/scanner-neural/";
/** The recogniser's four, which the first frame waits on (`assets.ts`' `NEURAL_FILES`). */
const NEURAL_FILES = ["detector.onnx", "embedder.onnx", "gallery.bin", "neural.json"];
/** The page's sentence for a Worker that trapped (`packages/ui/lib/core/web/scanner.ts`). */
const STOPPED = "The card scanner stopped unexpectedly. It starts again with the next frame.";

const mb = (bytes: number | null) => `${((bytes ?? 0) / 1e6).toFixed(2)} MB`;
const ms = (n: number) => `${Math.round(n)} ms`;
/** Whether a path the server was asked for is the scanner's: its module, or a Neural file. */
const isScanners = (path: string) =>
  /^\/wasm\/[^/]+\/scanner\//.test(path) || path.startsWith(NEURAL_PREFIX);
/** Whether it is one of the recogniser's four, of whatever set. */
const isRecognisers = (path: string) =>
  path.startsWith(NEURAL_PREFIX) && NEURAL_FILES.some((name) => path.endsWith(`/${name}`));

// ---------------------------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------------------------

/** The app's `User-Agent`, as the engine spells it to Scryfall (`scryfall::USER_AGENT`). */
const USER_AGENT = `MTGGrimoire/${(JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version} (https://github.com/Msgaihede/mtg-grimoire)`;

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
      const cause = error instanceof Error ? error.cause : undefined;
      why =
        cause instanceof Error
          ? cause.message
          : error instanceof Error
            ? error.message
            : String(error);
    }
  }
  return fail(
    `the card's picture could not be fetched from ${address} in three tries: ${why}. ` +
      "Set SCAN_CARD_PICTURE to a picture of Counterspell (MH2 267) to run without Scryfall.",
  );
}

/** A frame's RGBA as planar YUV 4:2:0, full range (BT.601 — what `C420jpeg` says it is). */
function yuv(rgba: Buffer, width: number, height: number) {
  const luma = Buffer.alloc(width * height);
  const u = Buffer.alloc((width / 2) * (height / 2));
  const v = Buffer.alloc((width / 2) * (height / 2));
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let cb = 0;
      let cr = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
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
async function cameraFile(scratch: string) {
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
    if (exceptionDetails)
      fail(`the card's picture would not decode: ${exceptionDetails.exception?.description}`);
    const frameInfo = result.value as { length: number; card: number[] };
    // A megabyte at a time: one DevTools message of the whole frame — five megabytes of
    // base64 — never arrives (measured, Chrome 154 and Node 24's WebSocket: 2 MB does, 5 MB
    // does not).
    let text = "";
    for (let at = 0; at < frameInfo.length; at += 1_000_000) {
      const slice = await browser.send(
        "Runtime.evaluate",
        { expression: `globalThis.__frame.slice(${at}, ${at + 1_000_000})`, returnByValue: true },
        sessionId,
      );
      text += slice.result.value as string;
    }
    rgba = Buffer.from(text, "base64");
    console.log(
      `    the card's picture is ${frameInfo.card.join(" × ")}, shown ${CARD_HEIGHT}px tall in a ${width} × ${height} frame`,
    );
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
  if (!name)
    fail("apps/light/dist-web/assets has no scanner-*.js chunk — the page's scanner moved.");
  return `/assets/${name}`;
}

const ADD = `[...document.querySelectorAll("button")].find((b) => /^Add \\d+ to collection/.test(b.innerText.trim()))`;
/** A row of the desktop shell's sidebar, by its word. */
const sidebar = (word: string) =>
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
const grab = (width: number) => `(async () => {
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
 * Cache Storage and an empty tray: a tray row the desktop leg left would make "the card is in the
 * tray" true before a frame was sent.
 */
async function phoneFace(
  origin: string,
  site: Site,
  routes: ReturnType<typeof fixtures>,
  camera: string,
  chunk: string,
) {
  const { browser, hosts, policy, close } = await browse(origin, routes, {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${camera}`,
    ],
  });
  const phone = (sessionId: string) =>
    browser.send(
      "Emulation.setDeviceMetricsOverride",
      { width: PHONE[0], height: PHONE[1], deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  const page = await openPage(browser, `${origin}/search`, hosts.check, policy, phone);
  const engine = async <M extends keyof ScanResults>(
    command: M,
    args?: Record<string, unknown>,
  ): Promise<ScanResults[M]> => {
    const answer = await page.evaluate<{ value: ScanResults[M]; refused?: string }>(
      `import(${JSON.stringify(chunk)})
        .then((module) => module.scanningCore.call(${JSON.stringify(command)}, ${JSON.stringify(args)}))
        .then((value) => ({ value }), (refused) => ({ refused: String(refused) }))`,
    );
    if (answer.refused !== undefined)
      fail(`on the phone face, ${command} was refused: ${answer.refused}`);
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
    if (performance.now() > stop)
      fail(`on the phone face the card sync never finished: ${JSON.stringify(sync)}`);
  }
  const prefs = await engine("scanner_prefs");
  await engine("set_scanner_prefs", { prefs: { ...prefs, finish: "nonfoil" } });
  const before = site.asked.length;

  await page.press("the Scanner tab", `${TABS}.querySelector('a[href="/scanner"]')`);
  await page.until("the phone's Scanner opened", `!!${buttonSaying("Start scanning")}`);
  const sideways = () =>
    page.evaluate<number>(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
    );
  if ((await sideways()) > 0)
    fail(`at ${PHONE[0]}px the Scanner scrolls ${await sideways()}px sideways`);
  if (await page.evaluate(`!!${ADD} && !/^Add 0 /.test(${ADD}.innerText.trim())`)) {
    fail("the phone's tray held a card before a frame was sent");
  }
  const early = site.asked.slice(before).filter((path) => path.startsWith(NEURAL_PREFIX));
  if (early.length > 0)
    fail(
      `on the phone face the Neural files were asked for before Start scanning: ${early.join(", ")}`,
    );

  // The page opens stopped (issue #1317): nothing is read until Start scanning is pressed.
  await page.press("Start scanning", buttonSaying("Start scanning"));
  await page.until(
    "on the phone face, the card was recognised and landed in the tray",
    `!!${ADD} && /^Add 1 to collection$/.test(${ADD}.innerText.trim())`,
    120_000,
  );
  if ((await sideways()) > 0)
    fail(`with a card in the tray the phone's Scanner scrolls ${await sideways()}px sideways`);
  await page.press("Add", ADD);
  await page.until(
    "on the phone face, the tray was filed",
    `!${ADD} || !/^Add 1 /.test(${ADD}.innerText.trim())`,
    30_000,
  );
  hosts.check();
  const thrown = page.thrown();
  if (thrown.length > 0) fail(`the phone's page threw:\n${thrown.join("\n")}`);
  console.log(
    `ok  on the phone face at ${PHONE[0]}px: Start scanning, ${CARD.name} in the tray and filed, ` +
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
  for (const variant of ["thumb", "grid", "display", "art"])
    routes.set(CARD.image_uris[variant], picture);

  const { browser, hosts, policy, close } = await browse(origin, routes, {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${camera}`,
    ],
  });
  const desktop = (sessionId: string) =>
    browser.send(
      "Emulation.setDeviceMetricsOverride",
      { width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  const page = await openPage(browser, `${origin}/search`, hosts.check, policy, desktop);

  /** One call through the page's scanning `Core`. `args` is JSON, or an expression for bytes. */
  const call = async <M extends keyof ScanResults>(
    command: M,
    args?: Record<string, unknown> | string,
  ) => {
    const answer = await page.evaluate<{ value: ScanResults[M]; refused?: string }>(
      `import(${JSON.stringify(chunk)})
        .then(async (module) => module.scanningCore.call(${JSON.stringify(command)}, ${
          typeof args === "string" ? `await ${args}` : JSON.stringify(args)
        }))
        .then((value) => ({ value }), (refused) => ({ refused: String(refused) }))`,
    );
    return answer;
  };
  const engine = async <M extends keyof ScanResults>(
    command: M,
    args?: Record<string, unknown> | string,
  ): Promise<ScanResults[M]> => {
    const answer = await call(command, args);
    if (answer.refused !== undefined) fail(`${command} was refused: ${answer.refused}`);
    return answer.value;
  };

  // ---- 1. the app, with the card in its corpus ----------------------------------------------
  await page.until(
    "the desktop face got past its startup gate",
    `!!${sidebar("Scanner")} || ${ALERT}`,
  );
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
  console.log(
    "ok  the app opened on the desktop face and ingested 7 cards, the camera's among them",
  );

  // The finish is the reader's to fix for this run: a printing made in more than one finish
  // lands with its finish unknown, and a row with an unknown finish is one Add leaves in the tray.
  const prefs = await engine("scanner_prefs");
  await engine("set_scanner_prefs", { prefs: { ...prefs, finish: "nonfoil" } });

  // ---- 2. the Scanner, stopped, and nothing of Neural's fetched ----------------------------------
  await page.press("the sidebar's Scanner", sidebar("Scanner"));
  await page.until("the Scanner opened", `!!${buttonSaying("Start scanning")}`);
  const early = site.asked.filter((path) => path.startsWith(NEURAL_PREFIX));
  if (early.length > 0)
    fail(`the Neural files were asked for before Start scanning: ${early.join(", ")}`);
  const before = await page.evaluate<Record<string, string[]>>(CACHES);
  const inShell = Object.entries(before)
    .filter(([name]) => name.startsWith(SHELL_PREFIX))
    .flatMap(([, paths]) => paths)
    .filter(isScanners);
  if (inShell.length > 0)
    fail(`the service worker precached the scanner's files: ${inShell.join(", ")}`);
  console.log(
    "ok  the Scanner opened stopped, and has fetched none of the Neural files; nothing of the scanner is in the shell",
  );

  // ---- 3. the card --------------------------------------------------------------------------------
  // The view opens stopped (issue #1317): a frame goes out only once Start scanning is pressed.
  const pressed = performance.now();
  await page.press("Start scanning", buttonSaying("Start scanning"));
  await page.until(
    "the card was recognised and landed in the tray",
    `!!${ADD} && /^Add 1 to collection$/.test(${ADD}.innerText.trim()) && document.body.innerText.includes(${JSON.stringify(CARD.name)})`,
    120_000,
  );
  const recognisers = site.asked.filter(isRecognisers);
  for (const name of NEURAL_FILES) {
    const asks = recognisers.filter((path) => path.endsWith(`/${name}`)).length;
    if (asks !== 1) fail(`${name} was asked for ${asks} times`);
  }
  console.log(
    `ok  ${CARD.name} was recognised and is in the tray (${ms(performance.now() - pressed)} after the press); ` +
      "the recogniser's four files were fetched once each",
  );

  // ---- 4. the session -------------------------------------------------------------------------
  const status = await engine("scanner_status");
  if (!status.neural.loaded || status.neural.error !== null || status.labels <= 0)
    fail(`the session did not load everything:\n${JSON.stringify(status, null, 2)}`);
  const kept = (await page.evaluate<Record<string, string[]>>(CACHES))[SCANNER_CACHE] ?? [];
  // The module and the recogniser's four. The evidence's four follow in the background, and may
  // still be on their way.
  const wanted = [
    ...new Set(
      site.asked.filter(
        (path) => isScanners(path) && (!path.startsWith(NEURAL_PREFIX) || isRecognisers(path)),
      ),
    ),
  ];
  const lost = wanted.filter((path) => !kept.includes(path));
  if (wanted.filter(isRecognisers).length !== NEURAL_FILES.length || lost.length > 0) {
    fail(
      `the scanner's cache holds ${JSON.stringify(kept)}; it should hold ${JSON.stringify(wanted)}`,
    );
  }
  console.log(
    `ok  the session built: the Neural files and ${status.labels} labels; the module and the ${wanted.length} files it asked for are kept`,
  );

  // ---- 5. the commit ----------------------------------------------------------------------------
  await page.press("Add", ADD);
  await page.until(
    "the tray was filed",
    `!${ADD} || !/^Add 1 /.test(${ADD}.innerText.trim())`,
    30_000,
  );

  // ---- 6. sixty frames, timed ---------------------------------------------------------------------
  await page.press("Stop scanning", buttonSaying("Stop scanning"));
  await pause(1500);
  await engine("scanner_reset");
  const timed = await page.evaluate<{
    frames: number[];
    named: string | null;
    memory: number | null;
  }>(`(async () => {
    const { scanningCore } = await import(${JSON.stringify(chunk)});
    const frames = [];
    let named = null;
    for (let i = 0; i < 60; i += 1) {
      const jpeg = await ${grab(640)};
      const t0 = performance.now();
      const verdict = await scanningCore.call("scanner_frame", jpeg);
      frames.push(performance.now() - t0);
      named = verdict.decision?.label?.name ?? named;
    }
    const memory = await scanningCore.call("host:scanner_memory");
    return { frames, named, memory };
  })()`);
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  if (timed.frames.length === 0 || timed.memory === null)
    fail(`no frame was timed: ${JSON.stringify(timed)}`);
  console.log(
    `ok  60 frames at a median ${ms(median(timed.frames))} (max ${ms(Math.max(...timed.frames))}); ` +
      `the module's memory stands at ${mb(timed.memory)}; decided: ${timed.named ?? "nothing"}`,
  );

  // ---- 7. a staged fault ------------------------------------------------------------------------
  const scanners = () => policy.workerScripts().filter(([, url]) => url.includes("scanWorker"));
  const gone = (sessionId: string | undefined) =>
    browser.heard.some(
      (m) => m.method === "Target.detachedFromTarget" && m.params.sessionId === sessionId,
    );
  const [first] = scanners()
    .filter(([id]) => !gone(id))
    .slice(-1);
  if (!first) fail("there is no scanner Worker to stage a fault in");
  const refused = page.evaluate(`(async () => {
    const { scanningCore } = await import(${JSON.stringify(chunk)});
    const jpeg = await ${grab(640)};
    return scanningCore.call("scanner_frame", jpeg).then(() => null, String);
  })()`);
  // Under the frame, or just behind it: either way the Worker has said it trapped.
  await browser.send(
    "Runtime.evaluate",
    {
      expression: `self.postMessage({ kind: "trapped", id: 0, message: "staged by the smoke run" })`,
    },
    first[0],
  );
  const sentence = await refused;
  if (sentence !== null && sentence !== STOPPED)
    fail(`the frame under the fault was refused with ${JSON.stringify(sentence)}`);
  for (const stop = performance.now() + 15_000; !gone(first[0]); await pause(100)) {
    if (performance.now() > stop) fail("the Worker that trapped was not ended");
  }
  const after = await call("scanner_frame", grab(640));
  if (after.refused !== undefined || after.value.ok !== true) {
    fail(`the frame after the fault was not answered: ${JSON.stringify(after).slice(0, 400)}`);
  }
  const [second] = scanners()
    .filter(([id]) => !gone(id))
    .slice(-1);
  if (!second || second[0] === first[0])
    fail("the frame after the fault was not answered by a new Worker");
  console.log(
    `ok  a staged fault ended the scanner's Worker${sentence === null ? "" : `, the frame in flight was refused ("${sentence}")`}, ` +
      "and the next frame was answered by a new one",
  );

  // ---- 8. leaving the Scanner -------------------------------------------------------------------
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
    if (performance.now() > stop)
      fail("the scanner's Worker was still alive 40 s after the Scanner was left");
  }
  const idle = performance.now() - left;
  if ((await engine("host:scanner_memory")) !== null)
    fail("the host still answers for a session after its Worker went");
  const t0 = performance.now();
  const rebuilt = await engine("scanner_status");
  const build = performance.now() - t0;
  if (rebuilt.labels !== status.labels)
    fail(`the session built again differently: ${JSON.stringify(rebuilt)}`);
  const fresh = await engine("host:scanner_memory");
  console.log(
    `ok  leaving the Scanner ended its Worker after ${ms(idle)}; a new session built in ${ms(build)} ` +
      `(the labels, the module from the service worker's cache) at ${mb(fresh)}`,
  );

  // ---- 9. offline --------------------------------------------------------------------------------
  const asked = site.asked.length;
  const fixtureAsks = hosts.asked.length;
  site.refusing = true;
  hosts.offline(true);
  await page.forget();
  await page.evaluate(`location.assign("/scanner")`);
  await page.until(
    "offline, the Scanner opened again",
    `!!${buttonSaying("Start scanning")} || ${ALERT}`,
    60_000,
  );
  const refusedOffline = await page.evaluate(ALERT);
  if (refusedOffline) fail(`offline, the app did not open:\n${refusedOffline}`);
  await page.press("Start scanning", buttonSaying("Start scanning"));
  await page.until(
    "offline, the card was recognised and landed in the tray",
    `!!${ADD} && /^Add 1 /.test(${ADD}.innerText.trim()) && document.body.innerText.includes(${JSON.stringify(CARD.name)})`,
    60_000,
  );
  // What was asked of a host that was not there: the worker's own script by the browser — a
  // load asks whether there is a newer one — and nothing else.
  const offlineAsks = [...new Set(site.asked.slice(asked))];
  const beyond = offlineAsks.filter((path) => path !== "/sw.js");
  if (beyond.length > 0) fail(`offline, the server was asked for ${beyond.join(", ")}`);
  const offlineStatus = await engine("scanner_status");
  if (!offlineStatus.neural.loaded)
    fail(`offline, the session is ${JSON.stringify(offlineStatus)}`);
  console.log(
    `ok  offline — the host refusing every connection, the HTTP cache emptied — a reload opened the Scanner ` +
      `and ${CARD.name} landed in the tray again; the host was asked for ${offlineAsks.join(" and ") || "nothing"} ` +
      `and nothing else (${hosts.asked.length - fixtureAsks} asks of other hosts, each failed)`,
  );
  site.refusing = false;
  hosts.offline(false);

  // ---- 10. the policy, and what crossed the wire ---------------------------------------------------
  hosts.check();
  const thrown = page.thrown();
  if (thrown.length > 0) fail(`the page threw:\n${thrown.join("\n")}`);
  const watched = policy.watched();
  for (const kind of ["worker-", "scanWorker-", "sw.js"]) {
    if (!watched.some((name) => name.includes(kind)))
      fail(`the policy was never listened to on ${kind}: ${watched}`);
  }
  console.log(
    `ok  the Content-Security-Policy refused nothing, on ${watched.length} targets — the page, both Workers and the service worker`,
  );

  await close();
  await phoneFace(origin, site, routes, camera, chunk);

  const brotli = (path: string) =>
    brotliCompressSync(readFileSync(path), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      .length;
  const scannerDir = readdirSync(join(DIST, "wasm"))
    .map((id) => join(DIST, "wasm", id, "scanner"))
    .find((dir) => existsSync(dir));
  if (!scannerDir) fail("the scanner WASM directory is missing");
  const neuralDir = join(DIST, NEURAL_PREFIX.slice(1));
  const neuralSets = existsSync(neuralDir) ? readdirSync(neuralDir) : [];
  if (neuralSets.length !== 1)
    fail(`apps/light/dist-web/scanner-neural/ holds ${neuralSets.length} sets, not one`);
  const setDir = join(neuralDir, neuralSets[0]);
  const files = [
    ...readdirSync(scannerDir).map((name) => join(scannerDir, name)),
    ...NEURAL_FILES.map((name) => join(setDir, name)),
  ];
  console.log(
    "    what a first scan fetches, as this server sent it (identity) and through brotli at level 5:",
  );
  for (const path of files) {
    console.log(
      `      ${path.slice(DIST.length + 1).replaceAll("\\", "/")}  ${statSync(path).size} B  ${brotli(path)} B`,
    );
  }
}

runAs("web:scanner-smoke", DEADLINE_MS, main);
