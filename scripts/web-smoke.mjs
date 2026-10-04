#!/usr/bin/env node
// The web host's smoke run: the built app, in a real browser, over the real engine.
//
//     npm run web:wasm && npm run web:build && npm run web:smoke
//
// A green suite proves the host it ran on, and no suite runs the WASM module: vitest drives the
// Worker's logic over a fake, and cargo compiles the engine for a browser without starting one.
// This is the run that instantiates it. It serves `dist-web/`, opens it in headless Chromium over
// the DevTools protocol, and asks five things:
//
//   1. the app got past its startup gate — the engine loaded, and opened and migrated a database
//      on a rollback journal, which the page says on its console
//   2. that database is in OPFS, in the folder the page names
//   3. a read came back through the engine — the Search page's wall, drawn from `search_cards`
//   4. a reload opens the database a second time
//   5. a second tab is told the app is open elsewhere, and offered a reload
//
// No dependencies, like `cdp.mjs`: Node has a global `WebSocket`, and Chromium prints its
// debugging address when it starts. The browser is `CHROME` when that is set (CI sets it),
// else the first of Chrome and Edge found where they install.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const DIST = resolve("dist-web");
/** The folder `src/lib/core/web/index.ts` asks the engine to keep its databases in. */
const OPFS_DIRECTORY = "mtg-grimoire";
/** How long the whole run may take. CI's step has a longer bound of its own behind this one. */
const DEADLINE_MS = 180_000;
const started = performance.now();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  // Chromium refuses to stream-compile a module served as anything else.
  ".wasm": "application/wasm",
};

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * What to stop, newest first: the server, the browser, its socket, its profile. Each is pushed
 * the moment it exists — a browser that fails to start must not leave the server listening, and
 * a listening server is what keeps this process alive after it has printed its verdict.
 */
const undo = [];
async function stopEverything() {
  while (undo.length > 0) await Promise.resolve(undo.pop()()).catch(() => undefined);
}

function fail(message) {
  console.error(`web-smoke: FAILED — ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/** `dist-web/` on a port of the system's choosing, with the history fallback a host gives it. */
async function serve() {
  if (!existsSync(join(DIST, "index.html"))) {
    fail("dist-web/index.html is missing. Run `npm run web:wasm` and `npm run web:build` first.");
  }
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = normalize(join(DIST, path));
    // A path that climbs out of the folder is nobody's request.
    const inside = file === DIST || file.startsWith(DIST + sep);
    // An address with no extension is a place in the app, and every place is the one document.
    const target = !inside ? null : extname(file) === "" ? join(DIST, "index.html") : file;
    try {
      if (target === null) throw new Error("outside");
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  undo.push(() => {
    server.close();
    // `close` waits for kept-alive sockets, which a killed browser may never hang up.
    server.closeAllConnections();
  });
  return `http://localhost:${server.address().port}`;
}

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

/** Start the browser and answer its DevTools address, which it prints once it is listening. */
async function launch(profile) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
  ];
  // A runner's kernel refuses the sandbox's namespaces to an unprivileged process, and the only
  // page this browser ever loads is the one this script serves.
  if (process.env.CI) args.push("--no-sandbox");
  const child = spawn(browserPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
  // Registered before anything can fail, so a browser that never listens is still stopped.
  undo.push(() => child.kill());
  let heard = "";
  return new Promise((found, lost) => {
    child.stderr.on("data", (chunk) => {
      heard += chunk;
      const hit = /DevTools listening on (ws:\/\/\S+)/.exec(heard);
      if (hit) found(hit[1]);
    });
    child.on("exit", (code) => lost(new Error(`the browser exited (${code}): ${heard}`)));
    // Unreferenced: a timer still pending must not hold a finished run open for its length.
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
  const heard = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return heard.push(message);
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, heard, close: () => socket.close() };
}

/** A tab on `url`, with what it threw kept. */
async function openPage(browser, url) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Page.navigate", { url }, sessionId);
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await browser.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "threw");
    return result.value;
  };
  /** Poll until `expression` is truthy; answer its value, or say what the page showed instead. */
  const until = async (what, expression, withinMs = 90_000) => {
    const stop = performance.now() + withinMs;
    for (;;) {
      // A navigation in flight has no document to ask; the next poll does.
      const value = await evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (performance.now() > stop || performance.now() - started > DEADLINE_MS) {
        const shown = await evaluate("document.body.innerText").catch(() => "(no document)");
        return fail(`${what} — never happened. The page shows:\n${shown}`);
      }
      await pause(250);
    }
  };
  const thrown = () =>
    browser.heard
      .filter((m) => m.sessionId === sessionId && m.method === "Runtime.exceptionThrown")
      .map((m) => m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  /** Every line the page wrote to its console, as text. */
  const said = () =>
    browser.heard
      .filter((m) => m.sessionId === sessionId && m.method === "Runtime.consoleAPICalled")
      .map((m) => m.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  const reload = () => browser.send("Page.reload", {}, sessionId);
  return { evaluate, until, thrown, said, reload };
}

/** The phone face's tab bar: drawn only once the startup gate has let the app through. */
const SHELL = `!!document.querySelector('nav[aria-label="Views"]')`;
/** What the gate draws instead when it failed. */
const ALERT = `document.querySelector('[role="alert"]')?.innerText`;
/** Every name in the app's OPFS folder, or `null` when the folder is not there. */
const OPFS = `(async () => {
  const root = await navigator.storage.getDirectory();
  let folder;
  try { folder = await root.getDirectoryHandle(${JSON.stringify(OPFS_DIRECTORY)}); }
  catch { return null; }
  const names = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      names.push(prefix + name);
      if (handle.kind === "directory") await walk(handle, prefix + name + "/");
    }
  };
  await walk(folder, "");
  return names;
})()`;

async function main() {
  const origin = await serve();
  const profile = await mkdtemp(join(tmpdir(), "grimoire-web-smoke-"));
  undo.push(async () => {
    // The browser lets go of its profile a moment after it is told to stop.
    await pause(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const browser = await connect(await launch(profile));
  undo.push(() => browser.close());

  /** How many times the page has said its database opened. */
  const OPENED = "database open in OPFS";
  const opens = (page) => page.said().filter((text) => text.includes(OPENED)).length;

  // A headless window is 800 wide — under the 1024 floor — so the face is the phone's, and its
  // tab bar is the thing to wait for.
  const first = await openPage(browser, `${origin}/search`);

  await first.until("the app got past its startup gate", `${SHELL} || ${ALERT}`);
  const refused = await first.evaluate(ALERT);
  if (refused) fail(`the first tab did not open its database:\n${refused}`);
  // The page says which journal each file got (`src/lib/core/web/index.ts`). The OPFS pool
  // refuses WAL, so anything but `delete` on either is a browser doing something new.
  const line = first.said().find((text) => text.includes(OPENED));
  const opened = /journal (\w+), corpus journal (\w+), schema (\d+)/.exec(line ?? "");
  if (!opened) {
    fail(`the page never said how its database opened. Console:\n${first.said().join("\n")}`);
  }
  if (opened[1] !== "delete" || opened[2] !== "delete") fail(`an unexpected journal: ${line}`);
  console.log(`ok  the engine loaded and opened its database — ${opened[0]}`);

  const files = await first.until("the database is in OPFS", OPFS);
  if (files.length === 0) fail(`OPFS has a ${OPFS_DIRECTORY} folder with nothing in it`);
  console.log(`ok  OPFS holds ${OPFS_DIRECTORY}/ with ${files.length} entries`);

  // An empty corpus: the wall's sentence is `search_cards`' answer, drawn. Nothing else on the
  // page says it, so it is a read that went to the engine and came back.
  await first.until(
    "a search came back through the engine",
    `document.body.innerText.includes("No cards match.")`,
  );
  console.log("ok  a read came back through the engine");

  // Waited for by the console line and not by the tab bar: for a moment after `Page.reload` the
  // document still answering is the old one, whose bar is already drawn. **This is "it opens a
  // second time", not "it kept what was written"** — nothing here can write through the engine,
  // so a browser that wiped OPFS between the two opens would pass. That a write survives was
  // driven by hand (light-app.md §9.1).
  const before = opens(first);
  await first.reload();
  for (const stop = performance.now() + 60_000; opens(first) <= before; await pause(250)) {
    if (performance.now() > stop) fail("the page never opened its database after a reload");
  }
  await first.until("the app came back after a reload", `${SHELL} || ${ALERT}`);
  const again = await first.evaluate(ALERT);
  if (again) fail(`the database did not open a second time:\n${again}`);
  console.log("ok  a reload opened the database again");

  const second = await openPage(browser, `${origin}/search`);
  const told = await second.until("a second tab was told", `${ALERT} || ${SHELL}`);
  if (told === true) fail("a second tab opened the database the first one holds");
  if (!/already open in another tab/.test(told)) fail(`a second tab said:\n${told}`);
  const offered = await second.evaluate(
    `[...document.querySelectorAll("a")].some((a) => a.innerText.trim() === "Reload")`,
  );
  if (!offered) fail("the second tab was told, and offered no Reload");
  console.log("ok  a second tab was told, and offered a reload");

  const thrown = [...first.thrown(), ...second.thrown()];
  if (thrown.length > 0) fail(`the page threw:\n${thrown.join("\n")}`);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`web-smoke: passed in ${seconds} s`);
}

// The one bound on the whole run. `until` polls against it too, but a protocol call that never
// answers — a navigation, an OPFS walk that never settles — polls nothing, so this is a timer
// and not a check. Unreferenced, so it never keeps a finished run alive.
setTimeout(async () => {
  console.error(`web-smoke: FAILED — still running after ${DEADLINE_MS / 1000} s`);
  await stopEverything();
  process.exit(1);
}, DEADLINE_MS).unref();

main()
  .catch((error) => {
    if (process.exitCode !== 1) {
      console.error(`web-smoke: FAILED — ${error.message}`);
      process.exitCode = 1;
    }
  })
  .finally(stopEverything);
