// The pairing scanner, driven with a camera: **one "device" shows an invite at a phone's width,
// a second points a (fake) camera at that very drawing and joins**.
//
//   npm run mobile:dev                        # the light app over the Storybook fake, port 5175
//   npm run mobile:scan-smoke                 # or: npm run mobile:scan-smoke -- http://localhost:5185
//
// `src/features/settings/QrScanner.tsx` says of itself that it has no vitest for its camera
// loop — jsdom has neither `getUserMedia` nor canvas pixels — and that the frame loop and the
// decode are "the live pass's to prove". This is that pass as a command, and it needs no camera,
// no phone and neither of the repo's two locks: a headless Chromium takes a file for a camera
// (`--use-file-for-fake-video-capture`), and the file is made here from a screenshot of the
// panel's own QR code at 360px wide. So what is proved is the whole chain a reader's two devices
// walk, with nothing substituted but the lens:
//
//   1. the offering page draws `sync_pairing_begin`'s matrix through `QrCode`, at a phone's
//      width, white behind it under the dark theme — and the drawing is inside its own frame;
//   2. that drawing, as pixels, is a symbol `jsQR` reads (checked here before any camera sees
//      it, so a failure further on is the scanner's and not the picture's);
//   3. the scanning page's `getUserMedia` → `<video>` → canvas → `jsQR` loop decodes it from a
//      640×480 camera frame and calls `sync_pairing_accept` with exactly the text in the code;
//   4. the six digits follow, and the viewfinder fits a phone held upright and one held sideways;
//   5. with the camera refused, the same press lands on a sentence and a box to type into, and
//      the typed code joins the same way.
//
// **What it cannot prove is the grant.** Chromium's flags answer the permission prompt for the
// page; on Android the prompt is the system's and the WebView's client forwards it
// (`RustWebChromeClient.onPermissionRequest`), and in an installed web app it is the browser's.
// Those are a real phone's to show.
//
// **It runs over the fake, and says so.** The invite is a real QR symbol of a code with no key
// in it (`.storybook/fake/qr.ts`), and `sync_pairing_accept` there checks its shape and not its
// checksum. What is real is everything on this side of the command: the drawing, the camera
// loop, the decoder and the call.
//
// No dependencies but the app's own decoder, like `cdp.mjs`: Node has a global `WebSocket`, and
// Chromium prints its debugging address when it starts. The browser is `CHROME` when that is
// set, else the first of Chrome and Edge found where they install.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import jsqrModule from "jsqr";

/** `jsqr` is a UMD bundle: under Node's ESM its function is the default, or the default's. */
const jsQR = typeof jsqrModule === "function" ? jsqrModule : jsqrModule.default;

const ORIGIN = (process.argv[2] ?? "http://localhost:5175").replace(/\/$/, "");
/** The relay's address, which the invite's QR is drawn against (`entitlement::RELAY_BASE`). */
const PAIR_URL = /^https:\/\/[a-z0-9.-]+\/pair#[0-9A-Z]{105}$/;
const DEADLINE_MS = 120_000;

/** Everything started, to stop whatever happens: browsers, then their profile directories. */
const undo = [];
const lines = [];
const say = (line) => {
  lines.push(line);
  console.log(line);
};

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
  const profile = await mkdtemp(join(tmpdir(), "grimoire-pairing-"));
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
 * A tab on the light app's Settings, sized as a phone under a touch pointer and the dark theme,
 * with the Sync group open.
 */
async function syncPanel(send, width, height) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  const size = (w, h) =>
    call("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: true,
    });
  await size(width, height);
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await call("Page.navigate", { url: `${ORIGIN}/settings` });

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

  await until(
    `document.querySelector('ul[aria-label="Settings sections"]') !== null`,
    `the light app at ${ORIGIN} — is \`npm run mobile:dev\` running?`,
    30_000,
  );
  await evaluate(`(() => {
    const visible = (el) => el.getBoundingClientRect().height > 0;
    const panel = () => document.querySelector('section[aria-labelledby="sync-heading"]');
    const button = (name, root = panel()) =>
      [...root.querySelectorAll('button')].filter(visible)
        .find((b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === name);
    const press = (name, root) => {
      const b = button(name, root);
      if (!b) throw new Error('no button named ' + name);
      b.scrollIntoView({ block: 'center' });
      b.click();
      return true;
    };
    const type = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.smoke = { panel, button, press, type };
    press('Sync', document.querySelector('ul[aria-label="Settings sections"]'));
  })()`);
  await until(`smoke.button('Pair a device') != null`, "the Sync panel");
  return { call, evaluate, until, size };
}

/* ------------------------------------------------------------------ pixels ------------- */

/** A PNG as Chromium's screenshot writes one — 8-bit RGB or RGBA, not interlaced — as RGBA. */
function decodePng(png) {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colour = body[9];
      if (body[8] !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) {
        fail(`a screenshot in a PNG form this reads none of (depth ${body[8]}, colour ${colour})`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const here = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      rows[y * stride + x] = (here + predicted) & 0xff;
    }
  }
  return { width, height, channels, rows };
}

/** How light a pixel of a decoded PNG is, 0–255. */
const luma = (image, x, y) => {
  const at = (y * image.width + x) * image.channels;
  return Math.round(
    0.299 * image.rows[at] + 0.587 * image.rows[at + 1] + 0.114 * image.rows[at + 2],
  );
};

/**
 * A camera's frame as its luma plane: `picture` centred on a dark ground, as a phone's screen is
 * in a room. `null` for `picture` is the room alone — a camera with nothing to read.
 */
function frame(width, height, picture) {
  const plane = Buffer.alloc(width * height, 36);
  if (picture) {
    const left = Math.floor((width - picture.width) / 2);
    const top = Math.floor((height - picture.height) / 2);
    for (let y = 0; y < picture.height; y += 1) {
      for (let x = 0; x < picture.width; x += 1) {
        plane[(top + y) * width + left + x] = luma(picture, x, y);
      }
    }
  }
  return plane;
}

/** What the app's decoder makes of a luma plane. */
function read(plane, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < plane.length; i += 1) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = plane[i];
    rgba[i * 4 + 3] = 255;
  }
  return jsQR(rgba, width, height)?.data ?? null;
}

/** A few seconds of one still frame, as the uncompressed video Chromium takes for a camera. */
function writeY4m(path, plane, width, height) {
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const one = Buffer.concat([Buffer.from("FRAME\n"), plane, chroma]);
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`),
      ...Array.from({ length: 30 }, () => one),
    ]),
  );
}

/* ------------------------------------------------------------------ the run ------------ */

async function run() {
  const scratch = await mkdtemp(join(tmpdir(), "grimoire-pairing-feed-"));
  undo.push(() => rm(scratch, { recursive: true, force: true }).catch(() => undefined));
  const [WIDTH, HEIGHT] = [640, 480];
  const empty = join(scratch, "room.y4m");
  const invite = join(scratch, "invite.y4m");
  writeY4m(empty, frame(WIDTH, HEIGHT, null), WIDTH, HEIGHT);
  const CAMERA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

  // ------------------------------------------------ 1. the offering device, at 360px ----
  const first = await launch([...CAMERA, `--use-file-for-fake-video-capture=${empty}`]);
  const offering = await syncPanel(first, 360, 800);
  await offering.evaluate(`smoke.press('Pair a device')`);
  await offering.until(`smoke.panel().querySelector('[data-testid="pairing-qr"]') !== null`, "the QR code");
  const drawn = await offering.evaluate(`(() => {
    const qr = smoke.panel().querySelector('[data-testid="pairing-qr"]');
    qr.scrollIntoView({ block: 'center' });
    const r = qr.getBoundingClientRect();
    const box = qr.closest('.rounded-md').getBoundingClientRect();
    const view = qr.closest('.overflow-y-auto').getBoundingClientRect();
    return {
      x: r.x, y: r.y, width: r.width, height: r.height,
      modules: Number(qr.getAttribute('viewBox').split(' ')[2]) - 8,
      ground: getComputedStyle(qr).backgroundColor,
      insideItsStep: r.left >= box.left && r.right <= box.right,
      whollyInView: r.top >= view.top && r.bottom <= view.bottom && r.left >= 0 && r.right <= innerWidth,
      sideways: document.scrollingElement.scrollWidth > innerWidth,
      code: qr.parentElement.querySelector('p').textContent,
      theme: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  if (drawn.modules !== 53) fail(`the invite is drawn as ${drawn.modules} modules, not 53`);
  if (drawn.ground !== "rgb(255, 255, 255)") fail(`the QR's ground is ${drawn.ground}, not white`);
  if (!drawn.insideItsStep) fail("the QR stands outside the step it is drawn in");
  if (!drawn.whollyInView) fail("the QR is not wholly on screen at 360px");
  if (drawn.sideways) fail("the offer scrolls sideways at 360px");
  if (drawn.width < 240) fail(`the QR is ${drawn.width}px wide at 360px — under 240`);
  say(
    `offer at 360x800: QR ${drawn.width}x${drawn.height}px, ${drawn.modules} modules ` +
      `(${((drawn.width - 8) / (drawn.modules + 8)).toFixed(2)}px each), white on ${drawn.theme}`,
  );

  const shot = await offering.call("Page.captureScreenshot", {
    format: "png",
    clip: { x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height, scale: 1 },
  });
  const picture = decodePng(Buffer.from(shot.data, "base64"));
  // The quiet zone: the picture's own edge, every side, is white.
  for (const [x, y] of [
    [6, 6],
    [picture.width - 7, 6],
    [6, picture.height - 7],
    [picture.width - 7, picture.height - 7],
    [picture.width >> 1, 6],
    [6, picture.height >> 1],
  ]) {
    if (luma(picture, x, y) < 250) fail(`the QR's quiet zone is not white at ${x},${y}`);
  }

  // ------------------------------------------------ 2. the picture, before any camera ---
  const plane = frame(WIDTH, HEIGHT, picture);
  const expected = read(plane, WIDTH, HEIGHT);
  if (expected === null) fail("the drawing does not decode as a QR code, even before a camera");
  if (!PAIR_URL.test(expected)) fail(`the QR does not carry a pairing URL: ${expected}`);
  if (expected.split("#")[1] !== drawn.code.replace(/-/g, "")) {
    fail("the QR and the typed code beside it are not the same invite");
  }
  say(`the drawing decodes: ${expected.slice(0, expected.indexOf("#") + 11)}… (${expected.length} bytes)`);
  writeY4m(invite, plane, WIDTH, HEIGHT);

  // ------------------------------------------------ 3. the viewfinder, nothing to read --
  const looking = await syncPanel(first, 360, 800);
  await looking.evaluate(`smoke.press('Scan a code')`);
  await looking.until(
    `/Point the camera at the code/.test(smoke.panel().textContent)`,
    "the camera to start",
  );
  for (const [w, h] of [
    [360, 800],
    [800, 360],
  ]) {
    await looking.size(w, h);
    await sleep(400);
    const seen = await looking.evaluate(`(() => {
      const video = smoke.panel().querySelector('video');
      const finder = video.parentElement;
      const view = finder.closest('.overflow-y-auto');
      // The open group's row is pinned over the top of the list, so the room is under it.
      const pinned = view.querySelector('button[aria-expanded="true"]').getBoundingClientRect();
      view.scrollTop += finder.getBoundingClientRect().top - pinned.bottom - 8;
      const says = finder.nextElementSibling.getBoundingClientRect();
      const r = finder.getBoundingClientRect();
      return {
        width: r.width, height: r.height,
        fits: r.top >= pinned.bottom - 1 && says.bottom <= view.getBoundingClientRect().bottom,
        playing: video.videoWidth + 'x' + video.videoHeight,
        cancel: smoke.button('Cancel').getBoundingClientRect().height,
      };
    })()`);
    if (!seen.fits) fail(`at ${w}x${h} the viewfinder and its sentence do not fit on screen`);
    if (seen.cancel < 44) fail(`at ${w}x${h} Cancel is ${seen.cancel}px tall under a finger`);
    say(
      `scanning at ${w}x${h}: viewfinder ${seen.width}x${seen.height}px with its sentence on ` +
        `screen, camera ${seen.playing}`,
    );
  }

  // ------------------------------------------------ 4. the scan ---------------------------
  const second = await launch([...CAMERA, `--use-file-for-fake-video-capture=${invite}`]);
  const joining = await syncPanel(second, 360, 800);
  await joining.evaluate(`(async () => {
    const core = await import('/.storybook/fake/core.ts');
    const { activeScope } = await import('/.storybook/fake/scope.ts');
    const own = activeScope().commands.sync_pairing_accept;
    window.accepted = [];
    core.registerCommands({
      sync_pairing_accept: (args) => { window.accepted.push(args.code); return own(args); },
    });
    return true;
  })()`);
  const before = performance.now();
  await joining.evaluate(`smoke.press('Scan a code')`);
  await joining.until(`window.accepted.length > 0`, "the scanner to read the code");
  const took = Math.round(performance.now() - before);
  const accepted = await joining.evaluate(`window.accepted`);
  if (accepted.length !== 1) fail(`the scan called sync_pairing_accept ${accepted.length} times`);
  if (accepted[0] !== expected) fail(`the scan handed over ${accepted[0]}, not the code's text`);
  const digits = await joining.until(
    `smoke.panel().querySelector('[data-testid="pairing-sas"]')?.textContent`,
    "the six digits",
  );
  if (!/^\d{6}$/.test(digits)) fail(`the joining device shows "${digits}", not six digits`);
  if (await joining.evaluate(`smoke.panel().querySelector('video') !== null`)) {
    fail("the viewfinder is still drawn after the code was read");
  }
  say(`scan: sync_pairing_accept called once with the code's text, ${took}ms after the press; digits ${digits}`);

  // ------------------------------------------------ 5. the camera refused ----------------
  const third = await launch(["--deny-permission-prompts"]);
  const refused = await syncPanel(third, 360, 800);
  await refused.evaluate(`smoke.press('Scan a code')`);
  const sentence = await refused.until(
    `smoke.panel().querySelector('[role="alert"]')?.textContent`,
    "the camera's refusal",
  );
  if (!/needs camera access/.test(sentence) || !/type the code instead/.test(sentence)) {
    fail(`a refused camera says: ${sentence}`);
  }
  const box = await refused.evaluate(`(() => {
    const area = smoke.panel().querySelector('textarea');
    if (!area) return null;
    smoke.type(area, ${JSON.stringify(expected)});
    const r = area.getBoundingClientRect();
    return {
      label: area.closest('label').querySelector('span').textContent.trim(),
      font: getComputedStyle(area).fontSize,
      height: r.height,
    };
  })()`);
  if (box === null) fail("a refused camera leaves no box to type the code into");
  await refused.evaluate(`smoke.press('Use this code')`);
  const typed = await refused.until(
    `smoke.panel().querySelector('[data-testid="pairing-sas"]')?.textContent`,
    "the six digits after typing",
  );
  if (typed !== digits) fail(`the typed code gave ${typed} and the scanned one ${digits}`);
  say(`camera refused: "${sentence}" — then "${box.label}" (${box.font}), and the same digits ${typed}`);
}

/**
 * Stop everything this run started, newest first — once. Each step is taken off the list before
 * it runs, so the deadline and the ordinary exit can both call this and neither repeats nor
 * skips a step the other was in the middle of. A step that throws must not strand the ones
 * behind it: what is left on the list is exactly the browsers still running.
 */
async function cleanUp() {
  for (let step = undo.pop(); step !== undefined; step = undo.pop()) {
    await Promise.resolve()
      .then(step)
      .catch(() => undefined);
  }
}

// **The deadline cleans up too.** It called `process.exit` alone at first, and a run that hung —
// a page that never answered, a browser that never listened — left three headless browsers and
// their profile directories behind for whoever ran it. Not unreferenced: a hang is the case where
// nothing else is keeping the process alive to be timed out.
setTimeout(() => {
  console.error(`pairing scan smoke: FAILED — still running after ${DEADLINE_MS / 1000}s`);
  void cleanUp().finally(() => process.exit(1));
}, DEADLINE_MS);

let code = 0;
try {
  await run();
  say("pairing scan smoke: OK");
} catch (error) {
  code = 1;
  console.error(`pairing scan smoke: FAILED — ${error.message}`);
} finally {
  await cleanUp();
}
// An exit and not a return: the deadline's timer is still pending and would hold a finished run
// open for the rest of its two minutes.
process.exit(code);
