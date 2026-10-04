#!/usr/bin/env node
// What an unpaged `pull` costs a browser: the light app's phase 6, step 6.5 — a measurement.
//
//     npm run web:wasm && npm run web:build
//     npm run web:sync-pull -- --ops 10000            a device left behind, then let through
//     npm run web:sync-pull -- --ops 10000 --live     the same import, heard as it is pushed
//     npm run web:sync-pull -- --ops 10000 --join     a device paired into a collection that size
//     npm run web:sync-pull -- --ops 10000 --join --claimed
//                                                      … whose owner was already in a group, so
//                                                      the relay's log holds the import as well
//     npm run web:sync-pull -- --ops 1000 --kbps 40   left behind, then let through a slow link
//
// **Not a check, and not CI's.** `web-sync-smoke.mjs` is the walk a pull request is held to; this
// is the run that says what the relay's one-response `pull` costs the engine's Worker — one
// thread, one linear memory — when the response is large. It takes half a minute at a thousand
// ops and five at fifty thousand, so no job runs it. It still fails, by name, when the two
// devices do not end up holding the same rows.
//
// **A sibling of the walk and not a mode of it**, because it shares the walk's harness and none
// of its shape: the walk is a line of assertions under a four-minute bound; this stages one
// scenario, samples three processes across it and prints figures. The relay, the two devices, the
// claim and the pairing are `web-smoke/sync-harness.mjs`'s, as the walk's are — so "paired" means
// here what it means there.
//
// **Nothing leaves the machine**, as there: every name but the relay's resolves to nothing, the
// relay's resolves to `wrangler dev --local` on loopback, and no mode of this script changes that.
//
// **How the log is made large — through the app's own commands.** The card file each device
// ingests on its first run is the smoke's six cards grown to up to thirty thousand printings
// (the harness's `grownCards`, the file `web-smoke.mjs`'s reload check uses). The importing device
// is then asked `collection_import_commit` — the command the import dialog's *Import* button
// sends — with a list of `--ops` lines, each a printing, finish and condition no other line
// names, so every line is a row of its own: fifty thousand lines to a call, a large file's worth.
// The engine's capture triggers write one `sync_ops` row per line inside that transaction, the
// live loop's debounce wakes, and `client::push` seals and posts them two hundred to an envelope.
// Nothing here builds an op, an envelope or a request.
//
// **How a device is left behind.** Its requests to the relay are held where the harness pauses
// every request (`intercept`'s `gate`): its socket stays up and rings, its loop starts a trip,
// and that trip's first request waits, unanswered, as one on a stalled link would. Opening the
// gate lets the trip through, and its `pull` is the whole of what was pushed meanwhile. The
// Worker is alive and idle while it waits, which is what lets its memory be read before and a
// command be asked of it throughout. `--live` holds nothing: the device takes the log as a
// stream of `head` frames.
//
// **What is read, and from where:**
//
// - the engine's **linear memory** — `WebAssembly.Memory`'s byte length, off the Worker's live
//   instance over its own DevTools session (`Runtime.queryObjects`), before and after. It never
//   shrinks, so the figure after is the peak.
// - the Worker's **JS heap** — `Runtime.getHeapUsage` on that session, five times a second. A
//   sample waits for the Worker's thread like any other message, so a stretch of synchronous
//   work is seen from either side of it and not inside.
// - the **tab's process** and **workerd's** — working set and its peak, from the operating
//   system's process table. Windows only; elsewhere the figures read `n/a`.
// - the **relay isolate's JS heap** — `Runtime.getHeapUsage` over wrangler's inspector, ten times
//   a second for the whole run.
// - the **requests** — the Worker's own `Network` events: when each was sent, when its headers
//   and its last byte arrived, and how many bytes that was, decoded and on the wire.
// - **deafness** — `search_cards` asked from the page every 100 ms across the whole of it, each
//   timed from the ask to the answer. The page's own thread is timed beside it, by a 50 ms
//   timer's lateness: that is the thread a reader's scrolling runs on.

import { spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";
import {
  ALERT,
  coreChunk,
  fail,
  fixtureCards,
  grownCardId,
  grownCards,
  pause,
  runAs,
  serve,
  undo,
} from "./web-smoke/harness.mjs";
import {
  claim,
  device,
  listenToSync,
  median,
  pair,
  relayAddress,
  seen,
  shape,
  startRelay,
} from "./web-smoke/sync-harness.mjs";

/** `--name value`, or `fallback`. */
function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

/** How many sync ops the import makes: one per line, each line a row of its own. */
const OPS = Number(option("ops", "1000"));
if (!Number.isInteger(OPS) || OPS < 1) {
  console.error("web-sync-pull: --ops takes a whole number of ops, at least 1");
  process.exit(2);
}
/** Which scenario: a device held back and let through, one that hears it live, or one that joins. */
const MODE = flag("join") ? "join" : flag("live") ? "live" : "behind";
/** With `--join`: the importing device was in a group of one already, so its import is on the
 *  relay's log — sealed under a key the joining device never held — beside the baseline. */
const CLAIMED = flag("claimed");
/** `--kbps <n>`: the pulling device reaches the relay over a link this slow from the moment it is
 *  let through ({@link slowLink}) — the run that asks whether the pull's whole-request deadline,
 *  two minutes in a browser, is ever met on one. */
const KBPS = Number(option("kbps", "0"));
/** The most printings the grown card file holds; past it a line is another finish or condition. */
const MAX_CARDS = 30_000;
/** The most lines handed to one `collection_import_commit` — one file, one transaction. */
const FILE_LINES = 50_000;
/** How long any one wait may take: a large run is slow everywhere at once. */
const PATIENCE_MS = 120_000 + OPS * 25;
const DEADLINE_MS = Number(option("deadline", String(360 + OPS / 50))) * 1000;

const FINISHES = ["nonfoil", "foil"];
const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"];
if (OPS > MAX_CARDS * FINISHES.length * CONDITIONS.length) {
  console.error(
    `web-sync-pull: ${OPS} lines cannot each be a row of their own over ${MAX_CARDS} printings`,
  );
  process.exit(2);
}

const MB = (bytes) => (bytes === null || bytes === undefined ? "n/a" : (bytes / 1e6).toFixed(1));
const round = (ms) => Math.round(ms);
const quantile = (list, q) =>
  [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * q))] ?? 0;

// ---------------------------------------------------------------------------------------------
// The operating system's word on a process
// ---------------------------------------------------------------------------------------------

/**
 * The browsers, workerd and Node as the system's process table has them, or `null` where this
 * does not know how to ask. One PowerShell call: `WorkingSetSize` is bytes and
 * `PeakWorkingSetSize` kilobytes, which is `Win32_Process`'s own inconsistency.
 */
function processTable() {
  if (process.platform !== "win32") return null;
  const ran = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe' OR " +
        "Name='workerd.exe' OR Name='node.exe'\" | Select-Object ProcessId,ParentProcessId," +
        "Name,WorkingSetSize,PeakWorkingSetSize,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (ran.status !== 0) return null;
  try {
    const rows = JSON.parse(ran.stdout);
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
      pid: row.ProcessId,
      parent: row.ParentProcessId,
      name: row.Name,
      set: Number(row.WorkingSetSize),
      peak: Number(row.PeakWorkingSetSize) * 1024,
      line: row.CommandLine ?? "",
    }));
  } catch {
    return null;
  }
}

/** Every process under `root`, at any depth. */
function under(table, root) {
  const found = [];
  for (let frontier = [root]; frontier.length > 0;) {
    const children = table.filter((row) => frontier.includes(row.parent));
    found.push(...children);
    frontier = children.map((row) => row.pid);
  }
  return found;
}

/** workerd, under the wrangler this run started: `{ set, peak }`, or `null`. */
function relayProcess(relay) {
  const table = processTable();
  if (!table) return null;
  const workerd = under(table, relay.pid).filter((row) => row.name === "workerd.exe");
  workerd.sort((a, b) => b.set - a.set);
  return workerd[0] ?? null;
}

/**
 * The relay isolate's own JS heap, sampled ten times a second over wrangler's inspector for as
 * long as the run lasts: `Runtime.getHeapUsage`, used and committed. The relay answers a pull in
 * one synchronous turn, so no sample lands inside one — what is seen is the heap either side of
 * it, and V8 gives committed pages back slowly, so the committed peak is close to what the turn
 * took. Answers `null`, having said why, where the inspector cannot be reached.
 *
 * **This is the figure Cloudflare's 128 MB is about, and it is not that limit's measure**: the
 * limit counts an isolate's JS heap and what it holds outside it, and local workerd enforces
 * none of it.
 */
async function relayHeap(relay) {
  try {
    const listed = await (await fetch(`http://127.0.0.1:${relay.inspector}/json`)).json();
    const address = listed[0]?.webSocketDebuggerUrl;
    if (!address) throw new Error(`no target listed: ${JSON.stringify(listed)}`);
    // wrangler's inspector proxy answers a client that names a local origin; Node's `WebSocket`
    // sends none unless handed one, which its options — undici's, not the standard's — allow.
    const socket = new WebSocket(address, {
      headers: { Origin: `http://127.0.0.1:${relay.inspector}` },
    });
    await new Promise((opened, refused) => {
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener(
        "error",
        (event) =>
          refused(
            new Error(
              `the socket to ${address} was refused: ${event.message ?? ""} ${JSON.stringify(listed)}`,
            ),
          ),
        { once: true },
      );
    });
    undo.push(() => socket.close());
    const heap = { first: null, used: 0, total: 0, samples: 0 };
    socket.addEventListener("message", (event) => {
      const usage = JSON.parse(event.data).result;
      if (typeof usage?.usedSize !== "number") return;
      heap.first ??= usage.usedSize;
      heap.used = Math.max(heap.used, usage.usedSize);
      heap.total = Math.max(heap.total, usage.totalSize);
      heap.samples += 1;
    });
    // Asked for the length of the run, and no longer: the socket closing is what ends it.
    void (async () => {
      for (let id = 1; socket.readyState === WebSocket.OPEN; id += 1, await pause(100)) {
        socket.send(JSON.stringify({ id, method: "Runtime.getHeapUsage" }));
      }
    })();
    return heap;
  } catch (error) {
    console.log(`--  the relay's own heap could not be watched: ${error.message}`);
    return null;
  }
}

/**
 * The renderer process a device's tab and its engine Worker live in — the largest renderer under
 * the browser this run started; the only other is a blank tab's. `pid` pins it once found.
 */
function tabProcess(dev, pid) {
  const table = processTable();
  if (!table) return null;
  const renderers = under(table, dev.pid).filter((row) => row.line.includes("--type=renderer"));
  if (pid !== undefined) return renderers.find((row) => row.pid === pid) ?? null;
  renderers.sort((a, b) => b.set - a.set);
  return renderers[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// A slow link
// ---------------------------------------------------------------------------------------------

/**
 * A TCP relay on loopback in front of the local relay's port, which can be told to hand the
 * browser its bytes no faster than a rate: `{ port, limit(bytesPerSecond) }`. TLS passes through
 * it unread, so what is paced is the wire — the compressed body.
 *
 * **Here because DevTools has no such thing for a Worker** (measured, Chrome 154):
 * `Network.emulateNetworkConditions` on a dedicated Worker's session answers *Not supported*, and
 * on the page's it does not reach the Worker's requests.
 */
async function slowLink(target) {
  let rate = Infinity;
  const open = new Set();
  const server = createServer((client) => {
    const upstream = connect(target, "127.0.0.1");
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        open.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.on("data", async (chunk) => {
      if (rate === Infinity) return void client.write(chunk);
      // A tenth of a second's worth at a time, and nothing more read until it has gone.
      upstream.pause();
      const slice = Math.max(1, Math.floor(rate / 10));
      for (let at = 0; at < chunk.length && !client.destroyed; at += slice) {
        client.write(chunk.subarray(at, at + slice));
        await pause(100);
      }
      upstream.resume();
    });
    upstream.on("end", () => client.end());
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  undo.push(() => {
    for (const socket of open) socket.destroy();
    server.close();
  });
  return { port: server.address().port, limit: (bytesPerSecond) => (rate = bytesPerSecond) };
}

// ---------------------------------------------------------------------------------------------
// The engine's Worker, watched
// ---------------------------------------------------------------------------------------------

/** The session of a device's engine Worker — the newest dedicated Worker listened to. */
function workerOf(dev) {
  const session = dev.policy.workers().at(-1);
  if (!session) fail(`${dev.name}: there is no engine Worker to watch`);
  return session;
}

/**
 * The byte length of every `WebAssembly.Memory` the Worker holds — the engine's linear memory.
 * Found once by walking the heap for the prototype's instances (which collects garbage first)
 * and kept on the Worker's global, so every later read is one property read.
 */
async function linearMemory(dev) {
  const session = workerOf(dev);
  const read = async (expression) => {
    const { result, exceptionDetails } = await dev.browser.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      session,
    );
    return exceptionDetails ? null : result.value;
  };
  const kept = await read(
    "globalThis.__grimoireMemories?.map((memory) => memory.buffer.byteLength) ?? null",
  );
  if (kept) return kept.reduce((sum, bytes) => sum + bytes, 0);
  const prototype = await dev.browser.send(
    "Runtime.evaluate",
    { expression: "WebAssembly.Memory.prototype" },
    session,
  );
  const { objects } = await dev.browser.send(
    "Runtime.queryObjects",
    { prototypeObjectId: prototype.result.objectId },
    session,
  );
  const sizes = await dev.browser.send(
    "Runtime.callFunctionOn",
    {
      objectId: objects.objectId,
      functionDeclaration: `function () {
        globalThis.__grimoireMemories = [...this];
        return this.map((memory) => memory.buffer.byteLength);
      }`,
      returnByValue: true,
    },
    session,
  );
  const found = sizes.result.value;
  if (!Array.isArray(found) || found.length === 0) {
    fail(`${dev.name}: the engine's Worker holds no WebAssembly.Memory`);
  }
  return found.reduce((sum, bytes) => sum + bytes, 0);
}

const heapOf = (dev) => dev.browser.send("Runtime.getHeapUsage", {}, workerOf(dev));

/**
 * What the probe searches for: a word no card carries. **Cheap on purpose, and that was measured
 * the hard way.** The grown card file is the same six names thirty thousand times over, so a
 * search for one of them matches five thousand printings and costs 68 ms there, against 1.7 ms
 * over a thousand cards; asked every 100 ms through a 29 s apply, the 290 asks queued behind it
 * then took 19 s to answer — in front of the trip's own ack — and the run reported the probe's
 * backlog as the pull's. A search that matches nothing costs a millisecond at any size, so what
 * a late answer measures is the wait and nothing else.
 */
const PROBE_ARGS = JSON.stringify({ req: { text: "xyzzy" } });

/** Ask the page's engine `search_cards` thirty times in a row, alone: what it costs unhindered. */
const ALONE = (chunk) => `(async () => {
  const { webCore } = await import(${JSON.stringify(chunk)});
  const took = [];
  for (let n = 0; n < 30; n += 1) {
    const from = performance.now();
    await webCore.call("search_cards", ${PROBE_ARGS});
    took.push(performance.now() - from);
  }
  return took;
})()`;

/**
 * Start asking, from the page: `search_cards` every 100 ms whether or not the last was answered
 * — a reader types on — each timed from the ask to its answer; and a 50 ms timer on the page's
 * own thread, whose lateness is how long that thread was kept from running.
 */
const PROBE = (chunk) => `import(${JSON.stringify(chunk)}).then(({ webCore }) => {
  const probe = (window.__probe = { asked: 0, answers: [], refused: 0, beats: 0, lateness: 0 });
  let last = performance.now();
  probe.beat = setInterval(() => {
    const now = performance.now();
    probe.beats += 1;
    probe.lateness = Math.max(probe.lateness, now - last - 50);
    last = now;
  }, 50);
  probe.ask = setInterval(() => {
    const from = performance.now();
    probe.asked += 1;
    webCore.call("search_cards", ${PROBE_ARGS}).then(
      () => probe.answers.push([Date.now() - (performance.now() - from), performance.now() - from]),
      () => { probe.refused += 1; probe.answers.push([Date.now(), -1]); },
    );
  }, 100);
  return true;
})`;
const PROBE_STOP = `(() => {
  clearInterval(window.__probe.ask);
  return window.__probe.asked;
})()`;
const PROBE_READ = `(() => {
  const { asked, answers, refused, beats, lateness, beat } = window.__probe;
  if (answers.length < asked) return null;
  clearInterval(beat);
  return { asked, answers, refused, beats, lateness };
})()`;

/**
 * Watch a device from now: its Worker's memory before, a probe from its page, its heap sampled,
 * and every request its Worker makes. `stop()` ends all of it and answers the figures.
 */
async function watch(dev, chunk) {
  const tabBefore = tabProcess(dev);
  const linearBefore = await linearMemory(dev);
  const heapBefore = await heapOf(dev);
  const alone = await dev.page.evaluate(ALONE(chunk));
  const mark = dev.browser.heard.length;
  const began = Date.now();
  await dev.page.evaluate(PROBE(chunk));

  const heap = { used: heapBefore.usedSize, total: heapBefore.totalSize, samples: 0 };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const now = await heapOf(dev).catch(() => null);
      if (now) {
        heap.used = Math.max(heap.used, now.usedSize);
        heap.total = Math.max(heap.total, now.totalSize);
        heap.samples += 1;
      }
      await pause(200);
    }
  })();

  return {
    mark,
    began,
    /** Every request the Worker has made since the watch began, as far as each has got. */
    requests: () => requestsOf(dev, mark),
    async stop() {
      sampling = false;
      await sampler;
      await dev.page.evaluate(PROBE_STOP);
      // Every ask is answered before the figures are read: one still queued behind the engine
      // is the longest wait there was.
      let probe = null;
      for (const end = performance.now() + PATIENCE_MS; probe === null; await pause(100)) {
        probe = await dev.page.evaluate(PROBE_READ);
        if (performance.now() > end) fail(`${dev.name}: a probe was never answered`);
      }
      const took = probe.answers.filter(([, ms]) => ms >= 0).map(([, ms]) => ms);
      const worst = probe.answers.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
      const tabAfter = tabBefore ? tabProcess(dev, tabBefore.pid) : null;
      return {
        ms: Date.now() - began,
        linear: { before: linearBefore, after: await linearMemory(dev) },
        heap: { before: heapBefore.usedSize, peakUsed: heap.used, peakTotal: heap.total },
        tab: tabBefore &&
          tabAfter && {
            before: tabBefore.set,
            peakBefore: tabBefore.peak,
            after: tabAfter.set,
            peak: tabAfter.peak,
          },
        probe: {
          alone: median(alone),
          asked: probe.asked,
          refused: probe.refused,
          median: median(took),
          p95: quantile(took, 0.95),
          worst: worst[1],
          worstAskedAt: worst[0],
          over250: took.filter((ms) => ms > 250).length,
        },
        page: { beats: probe.beats, lateness: probe.lateness },
        /** Every ask, `[when it was asked, how long it waited]` — for a caller that splits them. */
        waits: probe.answers,
        requests: requestsOf(dev, mark),
      };
    },
  };
}

/**
 * The requests a device's engine Worker made since `mark`, read off its `Network` events: each
 * `{ method, route, url, sent, answered, finished, decoded, wire, status, failed }`, times in
 * unix ms. A pre-flight is a request of its own there, with the method `OPTIONS`.
 */
function requestsOf(dev, mark) {
  const session = workerOf(dev);
  const byId = new Map();
  for (const message of dev.browser.heard.slice(mark)) {
    if (message.sessionId !== session || !message.method.startsWith("Network.")) continue;
    const event = message.params;
    if (message.method === "Network.requestWillBeSent") {
      byId.set(event.requestId, {
        method: event.request.method,
        // The address less its origin; `shape` takes the query off and the group out.
        route: shape(event.request.url.replace(/^[a-z]+:\/\/[^/]+/, "")),
        url: event.request.url,
        // The two clocks of one moment: every later stamp of this request is on the first.
        offset: event.wallTime - event.timestamp,
        sent: event.wallTime * 1000,
        answered: null,
        finished: null,
        decoded: 0,
        wire: 0,
        status: null,
        failed: null,
      });
      continue;
    }
    const request = byId.get(event.requestId);
    if (!request) continue;
    const at = (event.timestamp + request.offset) * 1000;
    if (message.method === "Network.responseReceived") {
      request.status = event.response.status;
      request.answered = at;
    } else if (message.method === "Network.dataReceived") {
      request.decoded += event.dataLength;
    } else if (message.method === "Network.loadingFinished") {
      request.finished = at;
      request.wire = event.encodedDataLength;
    } else if (message.method === "Network.loadingFailed") {
      request.failed = event.errorText;
      request.finished = at;
    }
  }
  return [...byId.values()];
}

/** The requests of one route, less its pre-flights. */
const routed = (requests, method, action) =>
  requests.filter(
    (request) => request.method === method && request.route === `/g/{group}/${action}`,
  );

// ---------------------------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------------------------

/** The ids of the committed six cards, in the file's order — the grown file's first six. */
function fixtureIds() {
  return fixtureCards().map((card) => card.id);
}

/**
 * Import lines `from` to `from + count` through the page's engine: one
 * `collection_import_commit`, as the import dialog sends it. Line `n` names printing
 * `n mod cards`, and a finish and a condition that change each time the printings come round —
 * so no two lines share a grain, and each is a row and an op of its own. A line carries what a
 * list exported from another collection tool carries: a quantity, a condition, a price, a date.
 */
const IMPORT = (chunk, from, count, cards) => `(async () => {
  const { webCore } = await import(${JSON.stringify(chunk)});
  const fixture = ${JSON.stringify(fixtureIds())};
  const grown = ${grownCardId.toString()};
  const FINISHES = ${JSON.stringify(FINISHES)};
  const CONDITIONS = ${JSON.stringify(CONDITIONS)};
  const items = [];
  for (let n = ${from}; n < ${from + count}; n += 1) {
    const card = n % ${cards};
    const lap = Math.floor(n / ${cards});
    items.push({
      cardId: card < fixture.length ? fixture[card] : grown(card),
      quantity: 1 + (n % 4),
      finish: FINISHES[lap % FINISHES.length],
      condition: CONDITIONS[Math.floor(lap / FINISHES.length) % CONDITIONS.length],
      purchasePrice: 0.25 + (n % 997) / 10,
      purchaseCurrency: "USD",
      acquiredAt: "2026-09-" + String(1 + (n % 28)).padStart(2, "0"),
      acquisitionSource: "Imported list",
    });
  }
  const began = performance.now();
  return webCore.call("collection_import_commit", { items, mode: "add", folderId: null }).then(
    (value) => ({ value, ms: performance.now() - began }),
    (refused) => ({ refused: String(refused) }),
  );
})()`;

/** Import all of `OPS` lines on `dev`, a file at a time. Answers what it took and what landed. */
async function importAll(dev, chunk, cards) {
  const began = Date.now();
  let added = 0;
  const files = [];
  for (let from = 0; from < OPS; from += FILE_LINES) {
    const count = Math.min(FILE_LINES, OPS - from);
    const out = await dev.page.evaluate(IMPORT(chunk, from, count, cards));
    if (out.refused !== undefined) fail(`${dev.name}: the import was refused: ${out.refused}`);
    added += out.value.added;
    files.push(out.ms);
  }
  if (added !== OPS) fail(`${dev.name}: ${OPS} lines imported as ${added} rows`);
  return { began, ended: Date.now(), files };
}

/** The phone face's Collection page holding nothing — its figures read nought and its one shelf
 *  says *Empty.* — and holding something: the figures moved and the shelf drew rows instead. */
const WALL_TEXT = "document.body.innerText";
const EMPTY_WALL = `/\\bUnique\\s+0\\b/.test(${WALL_TEXT}) && /\\bEmpty\\./.test(${WALL_TEXT})`;
const DRAWN_WALL = `/\\bUnique\\s+[1-9]/.test(${WALL_TEXT}) && !/\\bEmpty\\./.test(${WALL_TEXT})`;

const summaryOf = (dev) => dev.engine("collection_summary", { query: {} });

// ---------------------------------------------------------------------------------------------
// What is printed
// ---------------------------------------------------------------------------------------------

function memoryLine(figures) {
  const { linear, heap, tab } = figures;
  return (
    `linear memory ${MB(linear.before)} → ${MB(linear.after)} MB ` +
    `(+${MB(linear.after - linear.before)}); JS heap ${MB(heap.before)} MB used, peak ` +
    `${MB(heap.peakUsed)} used / ${MB(heap.peakTotal)} committed; the tab's process ` +
    (tab
      ? `${MB(tab.before)} MB before, ${MB(tab.after)} after, peak ${MB(tab.peak)}` +
        (tab.peak > tab.peakBefore ? "" : ` (set before the watch began)`)
      : "n/a")
  );
}

function probeLine(figures) {
  const { probe, page } = figures;
  return (
    `search_cards alone ${probe.alone.toFixed(1)} ms; asked ${probe.asked} times over ` +
    `${(figures.ms / 1000).toFixed(1)} s — median ${probe.median.toFixed(1)} ms, 95th ` +
    `${round(probe.p95)} ms, longest ${round(probe.worst)} ms, ${probe.over250} over 250 ms` +
    (probe.refused > 0 ? `, ${probe.refused} refused` : "") +
    `; the page's own thread was at most ${round(page.lateness)} ms late`
  );
}

/** One pull, as its Worker saw it. `next` is when the Worker next asked the relay anything. */
function pullLine(pull, next) {
  const since = /[?&]since=(\d+)/.exec(pull.url)?.[1];
  return (
    `since=${since}: ${MB(pull.decoded)} MB (${MB(pull.wire)} on the wire), headers after ` +
    `${round(pull.answered - pull.sent)} ms, the last byte ${round(pull.finished - pull.answered)} ms ` +
    `later` +
    (next ? `, read and applied in ${round(next - pull.finished)} ms` : "")
  );
}

/** What the relay answered since `from`, by route: counts, and each route's own time. */
function relayLine(relay, from) {
  const answered = relay.log.slice(from);
  const lines = [];
  for (const [method, action] of [
    ["POST", "push"],
    ["GET", "pull"],
    ["POST", "ack"],
  ]) {
    const mine = answered.filter(
      (entry) => entry.method === method && shape(entry.path) === `/g/{group}/${action}`,
    );
    const took = mine.map((entry) => entry.ms).filter((ms) => ms !== null);
    const refused = mine.filter((entry) => entry.status >= 400).length;
    lines.push(
      `${method} ${action} × ${mine.length}` +
        (took.length > 0 ? ` (median ${median(took)} ms, slowest ${Math.max(...took)} ms)` : "") +
        (refused > 0 ? ` — ${refused} refused` : ""),
    );
  }
  const preflights = answered.filter((entry) => entry.method === "OPTIONS").length;
  return `${lines.join(", ")}, ${preflights} pre-flights`;
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

async function main() {
  const relayAt = relayAddress();
  const { origin } = await serve();
  const chunk = coreChunk();
  const cards = Math.max(6, Math.min(OPS, MAX_CARDS));
  const file = grownCards(cards);

  const relay = await startRelay(origin);
  relayAt.port = relay.port;
  console.log(
    `--  ${OPS} ops, ${MODE}${CLAIMED ? " (claimed first)" : ""}: a card file of ${cards} ` +
      `printings, the relay under workerd on 127.0.0.1:${relay.port}`,
  );

  // The pulling device's requests to the relay wait on this; open, they wait on nothing.
  let held = null;
  let release = () => undefined;
  const gate = {
    wait: () => held ?? undefined,
    close() {
      held = new Promise((opened) => (release = opened));
    },
    open() {
      held = null;
      release();
    },
  };

  const first = await device("the importing device", "desktop", origin, relayAt, chunk, {
    cards: file,
  });
  // With `--kbps`, the pulling device reaches the relay through a link this run can slow down.
  const link = KBPS > 0 ? await slowLink(relay.port) : null;
  const second = await device(
    "the pulling device",
    "phone",
    origin,
    link ? { ...relayAt, port: link.port } : relayAt,
    chunk,
    { cards: file, gate: gate.wait },
  );
  const both = [first, second];
  // The startup gate, asked of the engine — **and given up on after three seconds, to be asked
  // again**: a document whose open is being refused or retried never answers a call, and an
  // evaluation that waits on one never returns to be polled. (Found under a machine at 96 % CPU:
  // one run sat on this wait until the whole run's deadline.) What the gate draws when it fails
  // ends the wait too, and is read just after.
  const PAST_GATE = `(${ALERT}) || Promise.race([
    import(${JSON.stringify(chunk)})
      .then((m) => m.webCore.call("startup_status"))
      .then((s) => s.state !== "loading", () => false),
    new Promise((later) => setTimeout(() => later(false), 3000)),
  ])`;
  for (const dev of both) {
    await dev.page.until(`${dev.name} got past its startup gate`, PAST_GATE);
    const refused = await dev.page.evaluate(ALERT);
    if (refused) fail(`${dev.name} did not open its database:\n${refused}`);
    await dev.engineUntil(
      "the first run's card sync finished",
      "sync_status",
      (s) => s.cardCount === cards && !s.syncing,
      PATIENCE_MS,
    );
    // The launch's other downloads too, so the reload below lands on an engine at rest and not
    // inside one of their synchronous tails (`web-smoke.mjs`'s last check is what that costs).
    for (const feed of ["oracle_tags_status", "art_tags_status", "combos_status"]) {
      await dev.engineUntil(
        `${feed} read as stored`,
        feed,
        (s) => (s.tagCount ?? s.combos) > 0 && !s.refreshing,
        PATIENCE_MS,
      );
    }
    // **Then the page is loaded again, and that is the device every figure below is taken on**:
    // a reader coming back to a tab whose card database is already there. The first run's
    // ingest leaves the engine's linear memory at its own high-water mark, which never comes
    // down — a pull measured in that Worker would be handed memory the ingest had already
    // paid for, and read as costing none.
    const ingested = await linearMemory(dev);
    await dev.page.evaluate("window.__firstRun = true");
    await dev.page.reload();
    await dev.page.until(
      `${dev.name} came back from its reload`,
      `window.__firstRun === undefined && (${PAST_GATE})`,
    );
    const reopened = await dev.page.evaluate(ALERT);
    if (reopened) fail(`${dev.name} did not open its database again:\n${reopened}`);
    await dev.page.evaluate(listenToSync(chunk));
    await dev.engineUntil(
      "the second launch settled",
      "sync_status",
      (s) => s.cardCount === cards && !s.syncing,
      PATIENCE_MS,
    );
    dev.ingested = ingested;
  }
  console.log(
    `--  both devices ingested the card file (linear memory ${MB(first.ingested)} and ` +
      `${MB(second.ingested)} MB after it) and were loaded again: ${MB(await linearMemory(first))} ` +
      `and ${MB(await linearMemory(second))} MB`,
  );
  const settled = (dev) =>
    dev.engineUntil(
      "its trips settled",
      "sync_relay_status",
      (s) => s.pending === 0 && s.lastSyncAt !== null,
      PATIENCE_MS,
    );
  /**
   * Wait until the pulling device holds the rows the relay was given — every one the importing
   * device holds, unless the relay's quota left some of them there (`rows` says how many it
   * stored) — and, when it is all of them, the same copies too.
   */
  const converged = async (rows = OPS) => {
    const want = await summaryOf(first);
    if (want.entries !== OPS) fail(`${first.name} holds ${want.entries} rows after its import`);
    let have = await summaryOf(second);
    for (const end = performance.now() + PATIENCE_MS; have.entries !== rows;) {
      if (performance.now() > end) {
        const status = await second.engine("sync_relay_status");
        const log = await second.engine("error_log_list", { limit: 5 });
        fail(
          `the two devices did not converge: ${rows} rows were sent, ${have.entries} are on ` +
            `${second.name}, whose sync reads ${JSON.stringify(status)} and whose log holds ` +
            `${JSON.stringify(log)}`,
        );
      }
      await pause(500);
      have = await summaryOf(second);
    }
    if (rows === OPS && have.totalCards !== want.totalCards) {
      fail(
        `the two devices hold different collections: ${JSON.stringify(want)} and ${JSON.stringify(have)}`,
      );
    }
    return have;
  };
  const result = { ops: OPS, mode: MODE, claimed: CLAIMED, cards };
  const relayIdle = relayProcess(relay);
  const relayIsolate = await relayHeap(relay);

  // ---- before the import: who is in a group ------------------------------------------------
  if (MODE !== "join") {
    await claim(first);
    await pair(first, second);
    for (const dev of both) await settled(dev);
    await second.go("collection");
    await seen(second, "its collection page drew, empty", EMPTY_WALL);
  } else if (CLAIMED) {
    await claim(first);
    await settled(first);
  }
  if (MODE === "behind") gate.close();

  // ---- the import, and its push ------------------------------------------------------------
  const logged = relay.log.length;
  const writer = await watch(first, chunk);
  const reader = MODE === "live" ? await watch(second, chunk) : null;
  const imported = await importAll(first, chunk, cards);
  const captured = (await first.engine("sync_relay_status")).pending;
  // Until the outbox is empty — or the relay says its log for this group is full (507 `quota`),
  // which defers the rest of the push: what is left then stays on the importing device, and the
  // other one can only ever be sent what was stored.
  const full = () =>
    relay.log.slice(logged).some((entry) => entry.method === "POST" && entry.status === 507);
  const { pending: left } = await first.engineUntil(
    "its outbox emptied, or the relay's log filled",
    "sync_relay_status",
    (s) => s.pending === 0 || full(),
    PATIENCE_MS,
  );
  const stored = OPS - (MODE === "join" && !CLAIMED ? 0 : left);
  if (left > 0 && captured > 0) {
    console.log(
      `--  the relay refused the push as past its group quota: ${captured - left} ops are on ` +
        `its log and ${left} wait on ${first.name}`,
    );
  }
  const pushedAt = Date.now();
  if (MODE === "live") await converged(stored);
  const convergedAt = Date.now();
  const wrote = await writer.stop();
  const pushes = routed(wrote.requests, "POST", "push");
  const pushed = pushes.length > 0 && {
    posts: pushes.length,
    preflights: wrote.requests.filter((r) => r.method === "OPTIONS" && r.route.endsWith("/push"))
      .length,
    firstSent: pushes[0].sent - imported.ended,
    ms: pushes.at(-1).finished - pushes[0].sent,
    failed: pushes.filter((r) => r.failed !== null || r.status !== 200).length,
  };
  // The import is one transaction and the engine answers nothing inside it, whoever is paired;
  // what the push adds is what was asked after it answered.
  const afterImport = wrote.waits
    .filter(([asked, ms]) => asked >= imported.ended && ms >= 0)
    .map(([, ms]) => ms);
  console.log(
    `ok  ${first.name} imported ${OPS} lines as ${OPS} rows in ` +
      `${imported.files.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(" + ")} ` +
      `(${imported.files.length} call${imported.files.length === 1 ? "" : "s"} of ` +
      `collection_import_commit), which left ${captured} ops pending` +
      (pushed
        ? `; its loop pushed them in ${pushed.posts} POSTs and ${pushed.preflights} pre-flights ` +
          `over ${(pushed.ms / 1000).toFixed(1)} s, the first ${round(pushed.firstSent)} ms after ` +
          `the import answered` +
          (pushed.failed > 0 ? ` — ${pushed.failed} of them failed` : "")
        : "; nothing was pushed — it is in no group") +
      `\n    its engine: ${memoryLine(wrote)}\n    its page: ${probeLine(wrote)}` +
      (afterImport.length > 0
        ? ` — and of the ${afterImport.length} asked after the import answered, median ` +
          `${median(afterImport).toFixed(1)} ms, longest ${round(Math.max(...afterImport))} ms`
        : ""),
  );
  Object.assign(result, {
    import: { files: imported.files, captured, left },
    push: pushed,
    writer: { linear: wrote.linear, heap: wrote.heap, tab: wrote.tab, probe: wrote.probe },
  });
  if (reader === null && MODE !== "join") {
    console.log(`    the relay answered: ${relayLine(relay, logged)}`);
  }

  // ---- the pull ---------------------------------------------------------------------------
  if (MODE === "behind") {
    const told = (await second.told()).applied.length;
    const watching = await watch(second, chunk);
    link?.limit((KBPS * 1000) / 8);
    const opened = Date.now();
    gate.open();
    // The trip that was waiting goes through; one that had given up is asked for by hand.
    const pullsSent = () => routed(watching.requests(), "GET", "pull");
    const pullOf = () => pullsSent().find((r) => r.finished);
    for (let waited = 0, asked = false; !pullOf(); waited += 100, await pause(100)) {
      second.hosts.check();
      if (waited > 20_000 && !asked && pullsSent().length === 0) {
        asked = true;
        await second.page.evaluate(
          `import(${JSON.stringify(chunk)}).then((m) => void m.webCore.call("sync_now").catch(() => undefined))`,
        );
      }
      if (waited > PATIENCE_MS) fail(`${second.name} never pulled after its gate opened`);
    }
    const ended = pullOf();
    if (ended.failed !== null) {
      // The pull did not arrive: on a slow link this is the engine's own deadline ending it.
      await pause(1_000);
      const read = await watching.stop();
      const log = await second.engine("error_log_list", { limit: 5 });
      const status = await second.engine("sync_relay_status");
      console.log(
        `ok  ${second.name}'s pull was given up on ${((ended.finished - ended.sent) / 1000).toFixed(1)} s ` +
          `after it was sent (${ended.failed}), with ${MB(ended.decoded)} MB of it read` +
          (KBPS > 0 ? ` over a link of ${KBPS} kbit/s` : "") +
          `; it holds ${(await summaryOf(second)).entries} rows, its sync reads ` +
          `${JSON.stringify(status)}, and its log says: ` +
          `${log.map((row) => row.message ?? JSON.stringify(row)).join(" | ") || "nothing"}\n` +
          `    its engine: ${memoryLine(read)}\n    its page: ${probeLine(read)}`,
      );
      console.log(
        `RESULT ${JSON.stringify({ ...result, kbps: KBPS, abandoned: { ms: ended.finished - ended.sent, decoded: ended.decoded, why: ended.failed } })}`,
      );
      for (const dev of both) await dev.close();
      return;
    }
    const applied = await seen(
      second,
      "its page was told sync:applied",
      `window.__sync.applied.length > ${told}`,
      async () => JSON.stringify(await second.engine("sync_relay_status")),
      PATIENCE_MS,
    );
    const drawn = await seen(
      second,
      "its collection page drew the rows",
      DRAWN_WALL,
      async () => "",
      PATIENCE_MS,
    );
    const outcome = (await second.told()).applied[told];
    const have = await converged(stored);
    const read = await watching.stop();
    const requests = read.requests.filter((r) => r.method !== "OPTIONS");
    const pulls = routed(requests, "GET", "pull");
    const pull = pulls.find((r) => r.decoded === Math.max(...pulls.map((p) => p.decoded)));
    const next = requests.find((r) => r.sent > pull.finished);
    console.log(
      `ok  ${second.name}, held back and then let through, pulled ${outcome.pulled} ops in ` +
        `${pulls.length} pull${pulls.length === 1 ? "" : "s"} and holds ${have.entries} rows` +
        (left === 0 ? `, as ${first.name} does` : ` — every one the relay stored`) +
        `\n    the pull — ${pullLine(pull, next?.sent)}\n` +
        `    from the request: headers ${round(pull.answered - pull.sent)} ms, body ` +
        `${round(pull.finished - pull.sent)} ms, applied and acking ` +
        `${next ? round(next.sent - pull.sent) : "?"} ms, sync:applied ` +
        `${round(outcome.at - pull.sent)} ms, the wall drawn ${round(drawn - pull.sent)} ms ` +
        `(the gate opened ${round(pull.sent - opened)} ms before it)\n` +
        `    its engine: ${memoryLine(read)}\n    its page: ${probeLine(read)}\n` +
        `    the relay answered: ${relayLine(relay, logged)}`,
    );
    Object.assign(result, {
      pull: {
        pulls: pulls.length,
        ops: outcome.pulled,
        decoded: pull.decoded,
        wire: pull.wire,
        headersMs: pull.answered - pull.sent,
        bodyMs: pull.finished - pull.sent,
        applyMs: next ? next.sent - pull.finished : null,
        appliedMs: outcome.at - pull.sent,
        drawnMs: drawn - pull.sent,
        seenMs: applied - pull.sent,
      },
      reader: { linear: read.linear, heap: read.heap, tab: read.tab, probe: read.probe },
    });
  }

  if (MODE === "live") {
    const read = await reader.stop();
    const requests = read.requests.filter((r) => r.method !== "OPTIONS");
    const pulls = routed(requests, "GET", "pull").filter((r) => r.finished !== null);
    const carrying = pulls.filter((r) => r.decoded > 200);
    const largest = pulls.reduce((a, b) => (b.decoded > a.decoded ? b : a), pulls[0]);
    const heads = second
      .events("Network.webSocketFrameReceived")
      .filter((event) => event.params.response.payloadData.startsWith("{")).length;
    const tellings = (await second.told()).applied.filter((told) => told.at >= reader.began);
    const have = await summaryOf(second);
    console.log(
      `ok  ${second.name}, live throughout, heard ${heads} head frames and made ${pulls.length} ` +
        `pulls (${carrying.length} that carried anything, ${MB(pulls.reduce((sum, r) => sum + r.decoded, 0))} MB ` +
        `in all), was told sync:applied ${tellings.length} times, and holds ${have.entries} rows ` +
        `within ${round(convergedAt - pushedAt)} ms of the importing device's outbox emptying\n` +
        `    its largest pull — ${pullLine(largest, requests.find((r) => r.sent > largest.finished)?.sent)}\n` +
        `    its engine: ${memoryLine(read)}\n    its page: ${probeLine(read)}\n` +
        `    the relay answered: ${relayLine(relay, logged)}`,
    );
    Object.assign(result, {
      pull: {
        pulls: pulls.length,
        carrying: carrying.length,
        heads,
        decoded: pulls.reduce((sum, r) => sum + r.decoded, 0),
        largest: largest.decoded,
        tellings: tellings.length,
      },
      reader: { linear: read.linear, heap: read.heap, tab: read.tab, probe: read.probe },
    });
  }

  if (MODE === "join") {
    if (!CLAIMED) await claim(first);
    await settled(first);
    const emitting = await watch(first, chunk);
    const joining = await watch(second, chunk);
    const { matched } = await pair(first, second);
    const have = await converged();
    const landed = Date.now();
    for (const dev of both) await settled(dev);
    const gave = await emitting.stop();
    const read = await joining.stop();
    const baseline = routed(gave.requests, "POST", "push");
    const requests = read.requests.filter((r) => r.method !== "OPTIONS");
    const pulls = routed(requests, "GET", "pull").filter((r) => r.finished !== null);
    const carrying = pulls.filter((r) => r.decoded > 200);
    const largest = pulls.reduce((a, b) => (b.decoded > a.decoded ? b : a), pulls[0]);
    const tellings = (await second.told()).applied.filter((told) => told.at >= joining.began);
    const status = await second.engine("sync_relay_status");
    const log = await second.engine("error_log_list", { limit: 50 });
    console.log(
      `ok  ${second.name} joined a collection of ${OPS} rows and holds ${have.entries} of them ` +
        `${((landed - matched) / 1000).toFixed(1)} s after Codes match\n` +
        `    ${first.name} sent the baseline in ${baseline.length} POSTs` +
        (baseline.length > 0
          ? ` over ${((baseline.at(-1).finished - baseline[0].sent) / 1000).toFixed(1)} s`
          : "") +
        `\n    its engine: ${memoryLine(gave)}\n    its page: ${probeLine(gave)}\n` +
        `    ${second.name} made ${pulls.length} pulls (${carrying.length} that carried anything, ` +
        `${MB(pulls.reduce((sum, r) => sum + r.decoded, 0))} MB in all) and was told sync:applied ` +
        `${tellings.length} times; its cursor is ${status.pullHeld === null ? "not held" : `held (${status.pullHeld})`} ` +
        `and its log holds ${log.length} row${log.length === 1 ? "" : "s"}` +
        (log.length > 0 ? `, the first: ${JSON.stringify(log[0].message ?? log[0])}` : "") +
        `\n    its largest pull — ${pullLine(largest, requests.find((r) => r.sent > largest.finished)?.sent)}\n` +
        `    its engine: ${memoryLine(read)}\n    its page: ${probeLine(read)}\n` +
        `    the relay answered: ${relayLine(relay, logged)}`,
    );
    Object.assign(result, {
      join: { ms: landed - matched, baselinePosts: baseline.length },
      emitter: { linear: gave.linear, heap: gave.heap, tab: gave.tab, probe: gave.probe },
      pull: {
        pulls: pulls.length,
        carrying: carrying.length,
        decoded: pulls.reduce((sum, r) => sum + r.decoded, 0),
        largest: largest.decoded,
        tellings: tellings.length,
        unreadable: log.length,
      },
      reader: { linear: read.linear, heap: read.heap, tab: read.tab, probe: read.probe },
    });
  }

  // ---- how it ended -----------------------------------------------------------------------
  const relayAfter = relayProcess(relay);
  const errors = [];
  for (const dev of both) {
    dev.hosts.check();
    const thrown = dev.page.thrown();
    if (thrown.length > 0) fail(`${dev.name} threw:\n${thrown.join("\n")}`);
    const log = await dev.engine("error_log_list", { limit: 50 });
    errors.push(`${dev.name}'s log holds ${log.length}`);
  }
  if (relay.said.length > 0) fail(`the relay said: ${relay.said.join(" | ")}`);
  console.log(
    `ok  neither page threw and the relay raised nothing; ${errors.join(", ")}; workerd's ` +
      `process ` +
      (relayIdle && relayAfter
        ? `was ${MB(relayIdle.set)} MB before the import, is ${MB(relayAfter.set)} MB now, and ` +
          `peaked at ${MB(relayAfter.peak)} MB`
        : "could not be read on this system") +
      (relayIsolate && relayIsolate.samples > 0
        ? `; its isolate's JS heap was ${MB(relayIsolate.first)} MB used at first and peaked at ` +
          `${MB(relayIsolate.used)} used / ${MB(relayIsolate.total)} committed ` +
          `(${relayIsolate.samples} samples)`
        : ""),
  );
  result.relay = {
    process: relayIdle &&
      relayAfter && { before: relayIdle.set, after: relayAfter.set, peak: relayAfter.peak },
    heap: relayIsolate && relayIsolate.samples > 0 ? relayIsolate : null,
  };
  console.log(`RESULT ${JSON.stringify(result)}`);
  for (const dev of both) await dev.close();
}

await runAs("web-sync-pull", DEADLINE_MS, main);
