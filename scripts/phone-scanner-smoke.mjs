// The phone face's Scanner page, driven with a camera: **a card is scanned, reviewed and filed,
// at a phone's width, under a touch pointer.**
//
//   pnpm mobile:dev                          # the light app over the Storybook fake, port 5175
//   pnpm mobile:scanner-smoke                # or: pnpm mobile:scanner-smoke http://localhost:5186
//   pnpm mobile:scanner-smoke --shots=out # also save the screenshots it takes into ./out
//
// `apps/light/phone/pages/ScannerPage.tsx` has a vitest suite, and jsdom gives that suite no camera,
// no canvas pixels and no layout. This is the pass that has all three, as a command, and it needs
// no phone and neither of the repo's two locks: a headless Chromium answers `getUserMedia` with
// its built-in test pattern (`--use-fake-device-for-media-stream`), and the Storybook fake's
// `scanner_frame` answers each frame the page really sends with the next step of a scripted pile
// of cards (`packages/fake/scannerScript.ts`). So what is proved, at 360×800 and at 412×915:
//
//   1. the page opens the camera once its prefs have loaded, and shapes the picture's box by the
//      stream — inside the screen, with the status line and the tray's heading still on it;
//   2. frames go out in the stored mode and **never ask for previews**, and each card the script
//      decides lands in the tray once — the second copy of a card counts onto its row;
//   3. *Stop scanning* stops the frames and keeps the picture;
//   4. a quantity steps, a folder is chosen from the sheet and stored;
//   5. nothing scrolls sideways, every control is at least 44px under the coarse pointer, and the
//      footer — the destination and Add — is on screen and pressable with 5 rows and with 40;
//   6. *Add* is one `scanner_tray_commit` for the chosen folder, the tray empties and the receipt
//      says what was filed;
//   7. leaving the page stops the camera's track, and so does hiding it past the grace;
//   8. with the scanner's data absent the page offers it in the slot kept for it — one sentence
//      with its size and a Download button — and adds nothing; a press draws the bar, and when
//      the data has landed the offer clears with no reload and the running camera names cards;
//   9. in Exact the card the script cannot pin waits in the tray as a question, and a press on a
//      candidate answers it;
//  10. on its side at 800×360 the camera's column and the tray's stand side by side, with nothing
//      off the screen, no control under 44px and Add under a thumb;
//  11. with the camera refused the page lands on its sentence.
//
// **What it cannot prove is everything the fake stands in for**: recognition (the script names its
// own cards whatever the lens shows), a phone's real frame rate, the detail frame (the script never
// asks for one), and the camera *grant* — Chromium's flags answer the prompt, where on Android it
// is the system's and in an installed web app the browser's. Those are a real phone's to show.
//
// No dependencies, like `pairing-scan-smoke.mjs`, whose browser launcher this is: Node has a
// global `WebSocket`, and Chromium prints its debugging address when it starts. The browser is
// `CHROME` when that is set, else the first of Chrome and Edge found where they install.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const SHOTS = args.find((a) => a.startsWith("--shots="))?.slice("--shots=".length) ?? null;
const ORIGIN = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:5175").replace(/\/$/, "");

// The dev server's root is `apps/light`, so a file outside it — the fake world, the shared UI — is
// served at `/@fs/<its absolute path>`, which is also the URL the app itself imported it by: the
// page's own copy of a module, not a second one. (`/packages/fake/core.ts` answers with the
// app's `index.html`, as any path the server does not know does.)
const FS = `/@fs/${resolve(import.meta.dirname, "..").replaceAll("\\", "/").replace(/^\//, "")}/`;
const DEADLINE_MS = 240_000;
/** The two phones the page is measured at. */
const PHONES = [
  [360, 800],
  [412, 915],
];
/** A phone on its side: past the page's 720px, where its two columns stand side by side. */
const SIDEWAYS = [800, 360];
/** `PARK_GRACE_MS` in `packages/ui/features/scanner/useParked.ts`. */
const PARK_GRACE_MS = 5000;

/** Everything started, to stop whatever happens: browsers, then their profile directories. */
const undo = [];
const say = (line) => console.log(line);

function fail(reason) {
  throw new Error(reason);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ the browser -------- */

function browserPath() {
  const named = process.env.CHROME;
  if (named) return named;
  const installed = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => existsSync(path));
  if (installed) return installed;
  return fail("no browser found. Set CHROME to a Chromium-based browser's executable.");
}

/** Start a headless browser with `flags`, and answer one DevTools socket to it. */
async function launch(flags) {
  const profile = await mkdtemp(join(tmpdir(), "grimoire-scanner-"));
  const child = spawn(
    browserPath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      ...flags,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  undo.push(async () => {
    child.kill();
    // The profile is locked for a moment after the process is told to go.
    await sleep(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(
      () => undefined,
    );
  });
  let heard = "";
  const address = await new Promise((found, lost) => {
    child.stderr.on("data", (chunk) => {
      heard += chunk;
      const hit = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (hit) found(hit[1]);
    });
    child.on("exit", (code) => lost(new Error(`the browser exited (${code}): ${heard}`)));
    setTimeout(() => lost(new Error(`the browser never listened: ${heard}`)), 30_000).unref();
  });

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
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

/**
 * What every page of the run carries before its own scripts: a record of anything that threw, and
 * the few helpers the steps below press and read with.
 */
const HELPERS = `(() => {
  window.thrown = [];
  window.addEventListener('error', (e) => window.thrown.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.thrown.push('unhandled: ' + String(e.reason)));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const named = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
  const controls = (root = document) =>
    [...root.querySelectorAll('button, a[href], input, select, textarea')].filter(visible);
  const button = (name, root) => controls(root).find((b) => named(b) === name);
  const starting = (prefix, root) => controls(root).find((b) => named(b).startsWith(prefix));
  const press = (el, what) => {
    if (!el) throw new Error('nothing to press: ' + what);
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  };
  const rows = () => [...document.querySelectorAll('[data-tray-row]')];
  const sheet = () => document.querySelector('[role="dialog"]');
  const status = () => document.querySelector('[role="status"][aria-label="Scanner status"]')?.textContent ?? '';
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  /** The page as a phone holds it: what is too small for a thumb, what hangs off the side, and
   *  where the footer stands against the tab bar. \`root\` is the page, or a sheet over it. */
  const measure = (root = document.querySelector('main')) => {
    const nav = document.querySelector('nav[aria-label="Views"]').getBoundingClientRect();
    const small = controls(root)
      .map((el) => ({ name: named(el) || el.tagName, ...box(el) }))
      .filter((c) => c.width < 43.5 || c.height < 43.5)
      .map((c) => c.name + ' ' + Math.round(c.width) + 'x' + Math.round(c.height));
    const off = [...root.querySelectorAll('*')].filter(visible)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5; })
      .map((el) => el.tagName + '.' + String(el.className).slice(0, 40));
    return { small, off, sideways: document.scrollingElement.scrollWidth > innerWidth, navTop: nav.top };
  };
  /** Is the middle of \`el\` really \`el\` to a finger — on screen, and under nothing? */
  const reachable = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  };
  window.smoke = { visible, named, controls, button, starting, press, rows, sheet, status, box, measure, reachable };
})()`;

/** A tab on the light app at `path`, sized as a phone under a touch pointer and the dark theme. */
async function openPage(send, width, height, path) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      fail(
        `the page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };
  const until = async (expression, what, timeout = 20_000) => {
    const end = performance.now() + timeout;
    for (;;) {
      const value = await evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (performance.now() > end) fail(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const go = async (to) => {
    await call("Page.navigate", { url: `${ORIGIN}${to}` });
    await until(
      `document.querySelector('nav[aria-label="Views"]') !== null && typeof window.smoke === 'object'`,
      `the light app at ${ORIGIN} — is \`pnpm mobile:dev\` running?`,
      30_000,
    );
  };
  const shot = async (name) => {
    if (SHOTS === null) return;
    const picture = await call("Page.captureScreenshot", { format: "png" });
    const file = resolve(SHOTS, `${width}-${name}.png`);
    writeFileSync(file, Buffer.from(picture.data, "base64"));
    say(`  shot: ${file}`);
  };
  const page = { call, evaluate, until, go, shot, close: () => send("Target.closeTarget", { targetId }) };
  // The page a failure is photographed on: the last one opened.
  current = page;
  await go(path);
  return page;
}

/** The page the run is on, for the picture a failure leaves behind when `--shots` is given. */
let current = null;

/* ------------------------------------------------------------------ the steps ---------- */

/** Wrap the fake's three commands the run reads the page's own calls off. */
const WATCH = `(async () => {
  const core = await import('${FS}packages/fake/core.ts');
  const { activeScope } = await import('${FS}packages/fake/scope.ts');
  const own = activeScope().commands;
  window.seen = { frames: [], commits: [], prefs: [] };
  core.registerCommands({
    scanner_frame: (bytes, options) => {
      window.seen.frames.push(JSON.parse(options.headers['x-scanner-options']));
      return own.scanner_frame(bytes, options);
    },
    scanner_tray_commit: (args) => { window.seen.commits.push(args); return own.scanner_tray_commit(args); },
    set_scanner_prefs: (args) => { window.seen.prefs.push(args.prefs); return own.set_scanner_prefs(args); },
  });
  return true;
})()`;

/** The camera's track, live — the page's own, read off its `<video>`. */
const TRACK = `document.querySelector('video')?.srcObject?.getVideoTracks()[0]`;

/** Check one measurement and say what was wrong with it, in the page's own names. */
function hold(where, m) {
  if (m.sideways) fail(`${where}: the page scrolls sideways`);
  if (m.off.length > 0) fail(`${where}: off the side of the screen — ${m.off.slice(0, 4).join(", ")}`);
  if (m.small.length > 0) fail(`${where}: under 44px for a thumb — ${m.small.slice(0, 6).join(", ")}`);
}

/** `n` rows of the fake corpus's own printings, as the tray stores them. */
const rowsOf = (n) => `Array.from({ length: ${n} }, (_, i) => {
  const card = [
    ["c1e0f201-42cb-46a1-901a-65bb4fc18f6c", "4c6a0c30-b547-4eff-8ff4-0ca25803c076", "Urza's Saga", "mh2", "259"],
    ["30e401e3-282b-4524-87e1-c6cd50cd6d00", "23467047-6dba-4498-b783-1ebc4f74b8c2", "Ancient Tomb", "tmp", "315"],
    ["b0faa7f2-b547-42c4-a810-839da50dadfe", "5089ec1a-f881-4d55-af14-5d996171203b", "Black Lotus", "lea", "232"],
    ["f29ba16f-c8fb-42fe-aabf-87089cb214a7", "4457ed35-7c10-48c8-9776-456485fdf070", "Lightning Bolt", "2x2", "117"],
  ][i % 4];
  return {
    key: 'smoke-' + i, cardId: card[0], oracleId: card[1], name: card[2], setCode: card[3],
    collectorNumber: card[4], finish: i % 7 === 3 ? 'unknown' : 'nonfoil', quantity: 1 + (i % 3),
    choices: [], addedAt: Date.now() - i,
  };
})`;

/** Put `rows` on screen as the tray, through the page's own cache entry, and answer what was there. */
const withTray = (rows) => `(async () => {
  const { queryClient } = await import('${FS}packages/ui/lib/query.ts');
  const was = queryClient.getQueryData(['scanner', 'tray']);
  queryClient.setQueryData(['scanner', 'tray'], ${rows});
  return was;
})()`;

async function phone(send, width, height) {
  const at = `${width}x${height}`;
  const page = await openPage(send, width, height, "/scanner");

  // ------------------------------------------------ 1. the camera, and its box ----------
  await page.until(`${TRACK}?.readyState === 'live' && document.querySelector('video').videoWidth > 0`, "the camera");
  await page.evaluate(WATCH);
  const cam = await page.evaluate(`(() => {
    const video = document.querySelector('video');
    const frame = smoke.box(document.querySelector('[data-camera-box]'));
    const heading = smoke.box([...document.querySelectorAll('h2')].find((h) => /Scanned cards/.test(h.textContent)));
    const footer = smoke.box(document.querySelector('main footer'));
    return { stream: video.videoWidth + 'x' + video.videoHeight, frame, headingBottom: heading.bottom, footerTop: footer.top,
             fit: getComputedStyle(video).objectFit + '/' + getComputedStyle(document.querySelector('[data-camera-box] canvas')).objectFit };
  })()`);
  if (cam.frame.width < width - 40) fail(`${at}: the camera's box is ${cam.frame.width}px wide`);
  if (cam.frame.height < 150) fail(`${at}: the camera's box is ${cam.frame.height}px tall`);
  if (cam.frame.height > height * 0.38 + 1) fail(`${at}: the camera's box is ${cam.frame.height}px — over its cap`);
  if (cam.fit !== "cover/cover") fail(`${at}: the video and the overlay are fitted ${cam.fit}`);
  if (cam.headingBottom > cam.footerTop) fail(`${at}: the tray's heading is under the footer before any scroll`);
  say(`${at}: camera ${cam.stream} in a ${Math.round(cam.frame.width)}x${Math.round(cam.frame.height)}px box, tray heading on screen`);

  // ------------------------------------------------ 2. cards land ------------------------
  await page.until(`smoke.rows().length >= 1`, "the first card to land");
  const first = await page.evaluate(`({ status: smoke.status(), row: smoke.rows()[0].textContent })`);
  if (!/Urza's Saga/.test(first.row)) fail(`${at}: the first row is "${first.row}"`);
  await page.shot("scanning");
  await page.until(`smoke.rows().length >= 2`, "the third card (the second is a second copy)");
  const landed = await page.evaluate(`smoke.rows().map((row) => [row.querySelector('span.text-sm').textContent, row.querySelector('output').textContent])`);
  if (JSON.stringify(landed) !== JSON.stringify([["Ancient Tomb", "1"], ["Urza's Saga", "2"]])) {
    fail(`${at}: after three cards the tray reads ${JSON.stringify(landed)}`);
  }

  // ------------------------------------------------ 3. stop ------------------------------
  await page.evaluate(`smoke.press(smoke.button('Stop scanning'), 'Stop scanning')`);
  await sleep(400);
  const stopped = await page.evaluate(`window.seen.frames.length`);
  await sleep(900);
  const later = await page.evaluate(`({ frames: window.seen.frames, live: ${TRACK}?.readyState, rows: smoke.rows().length,
    note: document.querySelector('[data-camera-box]').textContent })`);
  if (later.frames.length !== stopped) fail(`${at}: ${later.frames.length - stopped} frames went out after Stop`);
  if (later.live !== "live") fail(`${at}: Stop closed the camera (${later.live})`);
  if (!/Scanning stopped/.test(later.note)) fail(`${at}: a stopped scanner says "${later.note}"`);
  if (later.frames.some((f) => f.previews !== false || f.mode !== "fast")) {
    fail(`${at}: a frame went out with previews, or not in Fast`);
  }
  say(`${at}: ${later.frames.length} frames, every one Fast and without previews; 3 cards → 2 rows; Stop holds the picture`);

  // ------------------------------------------------ 4. a quantity, a folder ---------------
  await page.evaluate(`smoke.press(smoke.starting('One more Ancient Tomb'), 'the stepper')`);
  await page.until(`smoke.rows()[0].querySelector('output').textContent === '2'`, "the quantity to step");

  await page.evaluate(`smoke.press(smoke.starting('Folder: '), 'the destination')`);
  await page.until(`smoke.sheet() !== null && /Folder for scanned cards/.test(smoke.sheet().textContent)`, "the folder sheet");
  await sleep(350);
  hold(`${at}, the folder sheet`, await page.evaluate(`smoke.measure(smoke.sheet())`));
  await page.shot("folder-sheet");
  const folder = await page.evaluate(`(() => {
    const choice = smoke.controls(smoke.sheet()).filter((b) => b.closest('li')).find((b) => smoke.named(b) !== 'Collection');
    const name = choice.querySelector('span span').textContent;
    choice.click();
    return name;
  })()`);
  await page.until(`smoke.sheet() === null && smoke.starting('Folder: ') && smoke.named(smoke.starting('Folder: ')) === ${JSON.stringify(`Folder: ${folder}`)}`, "the chosen folder on the footer");
  const stored = await page.until(`window.seen.prefs.at(-1)?.folderId`, "the folder to be stored");

  // ------------------------------------------------ 5. measured ---------------------------
  hold(`${at}, two rows`, await page.evaluate(`smoke.measure()`));
  for (const n of [5, 40]) {
    const was = await page.evaluate(withTray(rowsOf(n)));
    await page.until(`smoke.rows().length === ${n}`, `${n} rows`);
    const m = await page.evaluate(`(() => {
      const main = document.querySelector('main');
      const footer = main.querySelector('footer');
      const add = smoke.starting('Add ', footer);
      const scroller = main.querySelector('.overflow-y-auto');
      scroller.scrollTop = scroller.scrollHeight;
      const f = smoke.box(footer);
      return { ...smoke.measure(), footerTop: f.top, footerBottom: f.bottom, add: smoke.reachable(add), folder: smoke.reachable(smoke.starting('Folder: ', footer)),
        scrolls: scroller.scrollHeight > scroller.clientHeight, lastRow: smoke.box(smoke.rows().at(-1)).bottom, mainBottom: smoke.box(main).bottom };
    })()`);
    hold(`${at}, ${n} rows`, m);
    if (!m.add || !m.folder) fail(`${at}, ${n} rows: the footer is not under a thumb (Add ${m.add}, folder ${m.folder})`);
    if (m.footerBottom > m.navTop + 0.5 || m.mainBottom > m.navTop + 0.5) fail(`${at}, ${n} rows: the footer runs under the tab bar`);
    if (m.lastRow > m.footerTop + 0.5) fail(`${at}, ${n} rows: the last row cannot be scrolled clear of the footer`);
    if (n === 40) await page.shot("forty-rows");
    say(`${at}: ${n} rows — footer ${Math.round(m.footerTop)}–${Math.round(m.footerBottom)} over the tab bar at ${Math.round(m.navTop)}, Add and the folder pressable, list ${m.scrolls ? "scrolls" : "fits"}`);
    await page.evaluate(withTray(JSON.stringify(was)));
    await page.until(`smoke.rows().length === 2`, "the scanned rows back");
  }

  // ------------------------------------------------ 6. Add --------------------------------
  await page.evaluate(`smoke.press(smoke.starting('Add 4 to collection'), 'Add')`);
  await page.until(`window.seen.commits.length === 1 && smoke.rows().length === 0`, "the commit, and an empty tray");
  const commit = await page.evaluate(`({ ...window.seen.commits[0], receipt: document.querySelector('main footer').parentElement.textContent })`);
  const copies = commit.items.reduce((sum, item) => sum + item.quantity, 0);
  if (commit.folderId !== stored) fail(`${at}: filed to ${commit.folderId}, chosen ${stored}`);
  if (copies !== 4 || commit.remaining.length !== 0) fail(`${at}: the commit took ${copies} copies and left ${commit.remaining.length} rows`);
  if (!commit.receipt.includes(`Added 4 copies to ${folder}.`)) fail(`${at}: the receipt reads "${commit.receipt}"`);
  say(`${at}: Add → one scanner_tray_commit of 4 copies into "${folder}", the tray empty, "Added 4 copies to ${folder}."`);

  // ------------------------------------------------ the options sheet ---------------------
  await page.evaluate(`smoke.press(smoke.button('Scanner options'), 'Options')`);
  await page.until(`smoke.sheet() !== null && /Scan mode/.test(smoke.sheet().textContent)`, "the options sheet");
  await sleep(350);
  hold(`${at}, the options sheet`, await page.evaluate(`smoke.measure(smoke.sheet())`));
  await page.shot("options-sheet");
  await page.evaluate(`smoke.press(smoke.controls(smoke.sheet()).find((b) => /^Filters/.test(b.textContent)), 'Filters')`);
  await page.until(`/Released/.test(smoke.sheet().textContent)`, "the filters page");
  hold(`${at}, the filters page`, await page.evaluate(`smoke.measure(smoke.sheet())`));
  await page.evaluate(`smoke.press(smoke.button('Close scanner options'), 'close')`);
  await page.until(`smoke.sheet() === null`, "the sheet to close");

  // ------------------------------------------------ 7. the camera lets go -----------------
  await page.evaluate(`(() => {
    window.track = ${TRACK};
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await sleep(1000);
  if ((await page.evaluate(`window.track.readyState`)) !== "live") fail(`${at}: a page hidden for a second closed its camera`);
  await page.until(`window.track.readyState === 'ended'`, "a hidden page to close its camera", PARK_GRACE_MS + 4000);
  await page.evaluate(`(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await page.until(`${TRACK}?.readyState === 'live' && ${TRACK} !== window.track`, "the camera to reopen on return");
  await page.evaluate(`(() => {
    window.track = ${TRACK};
    smoke.press(smoke.controls(document.querySelector('nav[aria-label="Views"]')).find((a) => smoke.named(a) === 'Collection'), 'the Collection tab');
  })()`);
  await page.until(`window.track.readyState === 'ended' && document.querySelector('video') === null`, "the camera to stop on leaving the page");
  say(`${at}: hidden — the camera closes after the grace and reopens on return; leaving the page stops its track`);

  // ------------------------------------------------ 8. no scanner data -------------------
  await page.go("/scanner?fault=scannerMissing");
  const SLOT = `document.querySelector('[data-scanner-data-slot]')`;
  const slot = await page.until(`${SLOT}?.textContent`, "the slot's offer");
  if (!/The scanner needs its card data — about 19 MB\./.test(slot)) fail(`${at}: with no data the slot says "${slot}"`);
  // The offer, and never the instruction it replaced: a file at a path nobody here can reach.
  if (/No reference bundle|No OCR models|Restart the app/.test(slot)) fail(`${at}: the slot still tells a phone to place a file — "${slot}"`);
  await page.until(`/Can't identify/.test(smoke.status())`, "the status line to say it cannot identify");
  await sleep(2500);
  const missing = await page.evaluate(`({ ...smoke.measure(), rows: smoke.rows().length, download: !!smoke.button('Download') })`);
  if (missing.rows !== 0) fail(`${at}: ${missing.rows} cards landed with no bundle`);
  if (!missing.download) fail(`${at}: the offer has no Download to press`);
  // `hold` is where the button is measured: with every other control, 44px under the pointer.
  hold(`${at}, no scanner data`, missing);
  await page.shot("assets-missing");
  // The press: the bar stands where the button was, and when the data has landed the offer is
  // gone — no restart, no reload — the line stops saying it cannot identify, and the camera that
  // was running all along starts naming cards.
  // The fake's download is half a second, so the bar is watched for from inside the page rather
  // than caught between two looks at it from here.
  await page.evaluate(`(() => {
    window.sawBar = false;
    new MutationObserver(() => {
      if (${SLOT}?.querySelector('[role="progressbar"]') && !smoke.button('Download')) window.sawBar = true;
    }).observe(document.body, { childList: true, subtree: true });
    smoke.press(smoke.button('Download'), 'Download');
  })()`);
  await page.until(`window.sawBar === true`, "the bar where the button was");
  await page.until(`${SLOT} === null`, "the offer to clear once the data has landed");
  await page.until(`!/Can't identify/.test(smoke.status())`, "the status line to stop saying it cannot identify");
  await page.until(`smoke.rows().length >= 1`, "a card to land once the scanner has its data", 30_000);
  say(`${at}: no scanner data — the offer with its size, a press, the bar, and a scanner that names cards with no reload`);

  // ------------------------------------------------ 9. Exact ------------------------------
  await page.go("/scanner");
  await page.until(`${TRACK}?.readyState === 'live'`, "the camera again");
  await page.evaluate(`smoke.press(smoke.button('Exact'), 'Exact')`);
  await page.until(`smoke.button('Exact').getAttribute('aria-pressed') === 'true'`, "Exact to take");
  await page.until(`smoke.rows().some((row) => /Pick a printing/.test(row.textContent))`, "the card Exact cannot pin", 30_000);
  await page.evaluate(`smoke.press(smoke.button('Stop scanning'), 'Stop scanning')`);
  const asking = await page.evaluate(`(() => {
    const row = smoke.rows()[0];
    row.scrollIntoView({ block: 'start' });
    return { ...smoke.measure(), rows: smoke.rows().length, choices: smoke.controls(row).map(smoke.named), status: smoke.status() };
  })()`);
  hold(`${at}, a row waiting on a pick`, asking);
  if (asking.choices.filter((name) => /^Lightning Bolt — /.test(name)).length !== 3) {
    fail(`${at}: the waiting row offers ${JSON.stringify(asking.choices)}`);
  }
  await sleep(300);
  await page.shot("tray-with-rows");
  await page.evaluate(`smoke.press(smoke.button('Lightning Bolt — STA 105'), 'a candidate')`);
  await page.until(`!/Pick a printing/.test(smoke.rows()[0].textContent) && smoke.starting('More printings of Lightning Bolt — STA 105') !== undefined`, "the pick to settle the row");
  // The printings sheet, from the row the pick just settled.
  await page.evaluate(`smoke.press(smoke.starting('More printings of Lightning Bolt — STA 105'), 'the printing')`);
  await page.until(`smoke.sheet() !== null && smoke.controls(smoke.sheet()).filter((b) => b.closest('li')).length >= 3`, "the printings sheet");
  await sleep(350);
  hold(`${at}, the printings sheet`, await page.evaluate(`smoke.measure(smoke.sheet())`));
  await page.evaluate(`smoke.press(smoke.controls(smoke.sheet()).find((b) => /^Use .*2X2/.test(smoke.named(b))), 'another printing')`);
  await page.until(`smoke.sheet() === null && smoke.starting('More printings of Lightning Bolt — 2X2 117') !== undefined`, "the printing handed back");
  say(`${at}: Exact — ${asking.rows} rows, the fifth card waits with three candidates; a press settles it, and the printings sheet hands another back`);

  const thrown = await page.evaluate(`window.thrown`);
  if (thrown.length > 0) fail(`${at}: the page threw — ${thrown.join(" | ")}`);
  await page.close();
}

/** The two-column arrangement, which nothing else measures: a phone on its side. */
async function sideways(send, width, height) {
  const at = `${width}x${height}`;
  const page = await openPage(send, width, height, "/scanner");
  await page.until(`${TRACK}?.readyState === 'live' && document.querySelector('video').videoWidth > 0`, "the camera");
  await page.until(`smoke.rows().length >= 2`, "three cards");
  await page.evaluate(`smoke.press(smoke.button('Stop scanning'), 'Stop scanning')`);
  await sleep(300);
  const m = await page.evaluate(`(() => {
    const main = document.querySelector('main');
    const footer = main.querySelector('footer');
    const camera = smoke.box(document.querySelector('[data-camera-box]'));
    const tray = smoke.box(main.querySelector('section'));
    const f = smoke.box(footer);
    return { ...smoke.measure(), camera, tray, footer: f, mainBottom: smoke.box(main).bottom,
      add: smoke.reachable(smoke.starting('Add ', footer)), folder: smoke.reachable(smoke.starting('Folder: ', footer)) };
  })()`);
  hold(at, m);
  if (m.camera.right > m.tray.left) fail(`${at}: the camera's column and the tray's are not side by side`);
  if (Math.abs(m.camera.top - m.tray.top) > 80) fail(`${at}: the tray starts ${Math.round(m.tray.top - m.camera.top)}px below the camera — one column, not two`);
  if (m.tray.width < 300) fail(`${at}: the tray's column is ${m.tray.width}px wide`);
  if (m.camera.width < 200) fail(`${at}: the camera's box is ${m.camera.width}px wide`);
  if (!m.add || !m.folder) fail(`${at}: the footer is not under a thumb (Add ${m.add}, folder ${m.folder})`);
  if (m.footer.bottom > m.mainBottom + 0.5 || m.footer.bottom > height + 0.5) fail(`${at}: the footer runs off the screen`);
  await page.shot("sideways");
  say(`${at}: side by side — camera ${Math.round(m.camera.width)}x${Math.round(m.camera.height)}, tray ${Math.round(m.tray.width)}px beside it, footer ${Math.round(m.footer.top)}–${Math.round(m.footer.bottom)}, Add and the folder pressable`);
  const thrown = await page.evaluate(`window.thrown`);
  if (thrown.length > 0) fail(`${at}: the page threw — ${thrown.join(" | ")}`);
  await page.close();
}

async function run() {
  if (SHOTS !== null) mkdirSync(resolve(SHOTS), { recursive: true });
  const CAMERA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
  const first = await launch(CAMERA);
  for (const [width, height] of PHONES) await phone(first, width, height);

  // ------------------------------------------------ 10. a phone on its side --------------
  await sideways(first, ...SIDEWAYS);

  // ------------------------------------------------ 11. the camera refused ---------------
  const second = await launch(["--deny-permission-prompts"]);
  const refused = await openPage(second, 360, 800, "/scanner");
  const sentence = await refused.until(
    `document.querySelector('[data-camera-box] [role="alert"]')?.textContent`,
    "the camera's refusal",
  );
  if (sentence !== "MTG Grimoire needs camera access to scan a card.") fail(`a refused camera says: ${sentence}`);
  await sleep(1500);
  const quiet = await refused.evaluate(`({ ...smoke.measure(), thrown: window.thrown, tray: /Cards you scan appear here/.test(document.querySelector('main').textContent) })`);
  hold("360x800, the camera refused", quiet);
  if (quiet.thrown.length > 0) fail(`a refused camera threw — ${quiet.thrown.join(" | ")}`);
  if (!quiet.tray) fail("a refused camera leaves no tray on the page");
  await refused.shot("camera-refused");
  say(`camera refused: "${sentence}" — the bar, the tray and the footer still drawn`);
}

/**
 * Stop everything this run started, newest first — once. `pairing-scan-smoke.mjs`'s, and for its
 * reason: the deadline and the ordinary exit can both call this, and a step that throws must not
 * strand the browsers behind it.
 */
async function cleanUp() {
  for (let step = undo.pop(); step !== undefined; step = undo.pop()) {
    await Promise.resolve()
      .then(step)
      .catch(() => undefined);
  }
}

setTimeout(() => {
  console.error(`phone scanner smoke: FAILED — still running after ${DEADLINE_MS / 1000}s`);
  void cleanUp().finally(() => process.exit(1));
}, DEADLINE_MS);

let code = 0;
try {
  await run();
  say("phone scanner smoke: OK");
} catch (error) {
  code = 1;
  console.error(`phone scanner smoke: FAILED — ${error.message}`);
  await current?.shot("failure").catch(() => undefined);
} finally {
  await cleanUp();
}
// An exit and not a return: the deadline's timer is still pending and would hold a finished run
// open for the rest of its minutes.
process.exit(code);
