#!/usr/bin/env node
// Live sync between two browsers, through the relay's own code: the light app's phase 6, end to
// end.
//
//     npm run web:wasm && npm run web:build && npm run web:sync-smoke
//     npm run web:sync-smoke -- --measure      the same, and what the loop costs an idle page
//
// `web-smoke.mjs` proves the web host on a device that has paired nothing. This is the run in
// which it pairs: two headless Chromiums on two profiles — two devices — each serving the built
// app under the production policy, and between them **the relay itself under workerd**
// (`wrangler dev --local` on `relay/wrangler.jsonc`: its `fetch`, its Durable Object, a local D1).
// It walks, in this order:
//
//   1. both devices get past their startup gate — the first on the six fixture cards, the second
//      with its card file still on its way, held — and each reads `off`
//   2. the first device claims a membership through the page's own claim-code field — the engine,
//      `/claim`, `/token` and the bearer gate all for real — and its socket comes up: `live`
//   3. **a device that leaves lets go of its socket**: the second device claims a membership of
//      its own, founds a group of one and goes `live`; it presses *Leave group*, and reads `off`
//      at once, never `offline`, its socket closed and nothing logged
//   4. the first device offers a pairing; the second types the code; both show the same six
//      digits; the first confirms; both read a group of two, both are `live` — **and the second
//      device's socket is the first one's group's**, where a loop that kept the socket it had
//      would still be listening to the group it left
//   5. **a paired device relaunches into its first ingest**: the second device's card file is
//      let go and its page reloaded, so the launch's card sync — thirty thousand cards — and the
//      loop's launch trip and socket share the engine's one connection; it reaches `live`,
//      finishes the ingest, and draws a wish the first device made meanwhile
//   6. **the doorbell**: the second device adds a card to its wishlist, and the first one's
//      wishlist page draws it with nothing pressed there — the write, the 3 s debounce, the
//      push, the relay's `head` frame, the trip it rings for, `sync:applied`, the refetch — and
//      the same the other way round, so each face has been both the writer and the one told
//   7. no request failed and nothing was logged; each socket's upgrade selected
//      `grimoire.live.v1`, and each `ping` it sent was answered `pong`
//   8. **a removed device is told**: the first device removes the second from the roster, the
//      relay closes the second's socket, and the second reads as in no group with nothing
//      pressed there — `offline`, the trip a reconnect starts with, and then `off`
//   9. the host's Content-Security-Policy refused nothing, on any target of either browser
//
// **What is not waited for**: the keepalive's period. A socket pings the moment it comes up and
// then every 45 s, and the walk is over in less; `--measure` sits idle long enough to see the
// second ping and says how far apart the two were.
//
// **The first device is the desktop face and the second the phone face** (1280 × 800 and
// 412 × 915), so both faces' Sync panels, both walls and both faces' `sync:applied` listeners are
// what is driven.
//
// **The page talks to the relay by its real name.** The engine's `RELAY_BASE` is compiled in and
// the policy's `connect-src` names that host, and both are what ships — so neither is varied
// for the test. Instead each browser is started resolving that one name to the local relay
// (`--host-resolver-rules=MAP <relay> 127.0.0.1:<port>, …`), the relay is served over TLS with
// wrangler's own self-signed certificate (`--local-protocol https`) because the engine dials
// `https://` and `wss://`, and the browser is told to accept it (`--ignore-certificate-errors`).
// Measured 2026-10-04, Chrome 154: `--host-rules` beside the smoke's catch-all resolver rule
// answers `ERR_NAME_NOT_RESOLVED`; one `--host-resolver-rules` with the relay's mapping first
// is what works, and keeps the fence — every other name still resolves to nothing.
//
// **One honest difference from production**: the relay's `APP_ORIGINS` is this run's own page
// origin (`http://localhost:<port>`) where the deployed one says `https://mtg-grimoire.app`.
// Its signing key is thirty-two random bytes drawn by each run and handed over with `--var`:
// `RELAY_HMAC_KEY` has no value in any file of this repository, this one included.
//
// **An entitlement without Patreon**: the local D1 is given the relay's schema and two rows — a
// membership and a claim code for it — before the relay starts. Everything after that is the
// code path a reader's own claim takes.
//
// **wrangler is not one of this repository's root dependencies.** It is looked for at
// `app-worker/node_modules/wrangler/` — where `npm ci --ignore-scripts --prefix app-worker` puts
// the one version that directory's lockfile pins, which is what CI does — and then at the path
// in `WRANGLER`, a `wrangler.js`. The only wrangler commands this runs are `d1 execute --local`
// and `dev --local`: nothing here reaches Cloudflare.
//
// **The relay, the devices, the claim and the pairing are `web-smoke/sync-harness.mjs`'s**, so
// that `web-sync-pull.mjs` — the measurement of one large `pull` — means the same things by them.

import {
  ALERT,
  buttonSaying,
  coreChunk,
  fail,
  grownCards,
  pause,
  runAs,
  serve,
} from "./web-smoke/harness.mjs";
import {
  OWN_CLAIM_CODE,
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

/** Also profile the engine's Worker for a minute, idle, unpaired and then paired. */
const MEASURE = process.argv.includes("--measure");
/** How long the whole walk may take; the idle minutes are on top when they are asked for. */
const DEADLINE_MS = MEASURE ? 420_000 : 240_000;
/** How long one idle profile runs. */
const IDLE_MS = 60_000;

/** How many cards the second device's card file holds: an ingest long enough for its launch's
 *  round trip and its socket to land inside (`web-smoke.mjs` has the same figure's measure). */
const GROWN_CARDS = 30_000;

/** The fixture cards the walk wishes for: one made on the first device while the second is
 *  relaunching, and then one in each direction. */
const RELAUNCH_WISH = "Forest";
const FIRST_WISH = "Rhystic Study";
const SECOND_WISH = "Lightning Bolt";

// ---------------------------------------------------------------------------------------------
// What the loop costs, when it is asked (`--measure`)
// ---------------------------------------------------------------------------------------------

/**
 * Profile the engine's Worker for `ms` and answer how long it was not idle.
 *
 * V8's sampling profiler, on the Worker's own DevTools session: every sample that is not the
 * `(idle)` node is the Worker's thread doing something — script, the engine's wasm, the
 * garbage collector, or `(program)`, which is native code under no script frame.
 */
async function busy(dev, ms) {
  const session = dev.policy.workers().at(-1);
  if (!session) fail(`${dev.name}: there is no engine Worker to profile`);
  await dev.browser.send("Profiler.enable", {}, session);
  await dev.browser.send("Profiler.setSamplingInterval", { interval: 200 }, session);
  await dev.browser.send("Profiler.start", {}, session);
  await pause(ms);
  const { profile } = await dev.browser.send("Profiler.stop", {}, session);
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const spent = new Map();
  profile.samples.forEach((id, at) => {
    const name = names.get(id) ?? "?";
    const kind =
      name === "(idle)" || name === "(program)" || name === "(garbage collector)" ? name : "script";
    spent.set(kind, (spent.get(kind) ?? 0) + (profile.timeDeltas[at] ?? 0));
  });
  const of = (kind) => (spent.get(kind) ?? 0) / 1000;
  const total = (profile.endTime - profile.startTime) / 1000;
  return {
    total,
    busy: total - of("(idle)"),
    script: of("script"),
    program: of("(program)"),
    collector: of("(garbage collector)"),
  };
}
const costLine = (cost) =>
  `${cost.busy.toFixed(1)} ms busy of ${(cost.total / 1000).toFixed(1)} s ` +
  `(${cost.script.toFixed(1)} ms in script and wasm, ${cost.program.toFixed(1)} ms native, ` +
  `${cost.collector.toFixed(1)} ms collecting)`;

/**
 * A page command issued over and over while a round trip runs: how long each waited.
 *
 * `sync_now` is the trip — the same `run_once` the loop's own trips are, under the same lane —
 * and `search_cards` is the command a reader's typing sends. On one thread the search can only
 * be answered between two of the trip's stretches, so what is measured is the longest stretch.
 */
const STARVATION = (chunk) => `(async () => {
  const { webCore } = await import(${JSON.stringify(chunk)});
  const search = async () => {
    const from = performance.now();
    await webCore.call("search_cards", { req: { text: "bolt" } });
    return performance.now() - from;
  };
  const alone = [];
  for (let n = 0; n < 30; n += 1) alone.push(await search());
  let over = false;
  const from = performance.now();
  const trip = webCore.call("sync_now").then((outcome) => ((over = true), outcome));
  const beside = [];
  while (!over) beside.push(await search());
  const outcome = await trip;
  return { alone, beside, tripMs: performance.now() - from, outcome };
})()`;
// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

async function main() {
  const relayAt = relayAddress();
  const { origin } = await serve();
  const chunk = coreChunk();

  const began = performance.now();
  const relay = await startRelay(origin);
  relayAt.port = relay.port;
  console.log(
    `ok  the relay is up under workerd on 127.0.0.1:${relay.port} (TLS), answering as ` +
      `${relayAt.host} to pages of ${origin} — ${Math.round(performance.now() - began)} ms`,
  );

  // Two devices. The first holds the membership, offers the pairing and removes the second.
  // **The second's card file is thirty thousand cards and is held on its way**, so it pairs
  // with no card in its database, and its first ingest is the one its relaunch makes — with
  // the loop already in a group (step 5 of the header).
  const first = await device("the desktop face", "desktop", origin, relayAt, chunk);
  const second = await device("the phone face", "phone", origin, relayAt, chunk, {
    cards: grownCards(GROWN_CARDS),
    holdCards: true,
  });
  const both = [first, second];

  for (const dev of both) {
    await dev.page.until(
      `${dev.name} got past its startup gate`,
      `import(${JSON.stringify(chunk)}).then((m) => m.webCore.call("startup_status")).then((s) => s.state !== "loading")`,
    );
    const refused = await dev.page.evaluate(ALERT);
    if (refused) fail(`${dev.name} did not open its database:\n${refused}`);
    await dev.page.evaluate(listenToSync(chunk));
    const size = await dev.page.evaluate("`${innerWidth} × ${innerHeight}`");
    await dev.engineUntil(
      dev === first ? "the first run's card sync finished" : "the held first run is waiting",
      "sync_status",
      (s) => (dev === first ? s.cardCount === 6 && !s.syncing : s.cardCount === 0 && s.syncing),
    );
    const live = await dev.engine("sync_live_state");
    if (live !== "off") fail(`${dev.name} is in no group and reads ${live}`);
    dev.label = `${dev.name} (${size})`;
  }
  if (relay.log.length > 0 || both.some((dev) => dev.policy.sockets.length > 0)) {
    fail(`before anything was paired the relay was asked: ${JSON.stringify(relay.log)}`);
  }
  console.log(
    `ok  two devices on two profiles — ${first.label} with 6 cards and ${second.label} with ` +
      "its card file still on its way — each reading off, and the relay asked nothing",
  );

  if (MEASURE) {
    const cost = await busy(first, IDLE_MS);
    console.log(
      `ok  idle and in no group, the engine's Worker was ${costLine(cost)} — the loop's five-second read of sync_group among it`,
    );
  }

  // ---- the claim -------------------------------------------------------------------------
  const { founded, claimed, dialled, up } = await claim(first);
  console.log(
    `ok  ${first.name} claimed with the code a reader types, founded a group of one ` +
      `(${founded.deviceName}), and its socket is live — ${dialled.at - claimed} ms from the ` +
      `press to connecting (the loop's five-second read), ${up.at - dialled.at} ms from ` +
      "connecting to live (a round trip, then the upgrade)",
  );

  // ---- a group of its own, and leaving it ---------------------------------------------------
  // The regression's first half. The second device founds a group and holds its socket; then
  // it leaves. A loop that asked which group it was in only between sockets kept this one —
  // reading `live`, on the group it had left — for as long as the socket lived.
  const own = await claim(second, OWN_CLAIM_CODE);
  if (own.founded.groupId === founded.groupId) fail("the two claims founded one group");
  const ownSocket = second.policy.sockets.at(-1);
  if (!ownSocket?.url.includes(`/g/${own.founded.groupId}/ws`)) {
    fail(`${second.name}'s socket is not its own group's: ${ownSocket?.url}`);
  }
  const leaving = Date.now();
  await second.page.press("Leave group", buttonSaying("Leave group"));
  await second.page.press(
    "the dialog's Leave the group",
    buttonSaying("Leave the group", '[role="dialog"]'),
  );
  await second.engineUntil("it left its group", "sync_pairing_status", (s) => s.groupId === null);
  await second.engineUntil("its loop said off", "sync_live_state", (s) => s === "off", 10_000);
  const wentOff = (await second.told()).live.at(-1);
  for (const stop = performance.now() + 10_000; !second.lastSocketClosed(); await pause(50)) {
    if (performance.now() > stop) fail(`${second.name} left its group and kept its socket`);
  }
  const leftSaid = (await second.told()).live.map((event) => event.state);
  if (leftSaid.join() !== "connecting,live,off") {
    fail(`${second.name} left its group and said ${leftSaid.join(", ")}`);
  }
  const leftLog = await second.engine("error_log_list", { limit: 50 });
  if (leftLog.length > 0)
    fail(`${second.name} left its group and logged: ${JSON.stringify(leftLog)}`);
  console.log(
    `ok  ${second.name} claimed a membership of its own, founded a group of one and went live; ` +
      `it pressed Leave group and let go of its socket — off ${wentOff.at - leaving} ms after ` +
      "the press, never offline, the socket closed, nothing logged",
  );

  // ---- the pairing -----------------------------------------------------------------------
  const { code, offering, joined, joinedUp } = await pair(first, second);
  // The regression's second half: the socket the second device holds now is the group's it
  // joined. Kept from before, it would be the address of the group it left.
  const joinedSocket = second.policy.sockets.at(-1);
  if (joinedSocket === ownSocket || !joinedSocket.url.includes(`/g/${founded.groupId}/ws`)) {
    fail(
      `${second.name} joined ${founded.groupId} and its socket is ${joinedSocket.url} ` +
        `(the group it left was ${own.founded.groupId})`,
    );
  }
  console.log(
    `ok  paired — a ${code.length}-character code typed into ${second.name}, ${offering} on both, ` +
      `Codes match on ${first.name}; both read a group of 2 devices and both are live ` +
      `(${second.name}: ${joinedUp.at - joined.at} ms from connecting to live), and ` +
      `${second.name}'s socket is the group's it joined, not the one it left`,
  );
  // The trips a completed pairing owes — each side's first exchange — settle before the walk
  // measures a write of its own: nothing pending on either device.
  for (const dev of both) {
    await dev.engineUntil(
      "the pairing's own trips settled",
      "sync_relay_status",
      (s) => s.pending === 0 && s.lastSyncAt !== null,
    );
  }

  if (MEASURE) {
    const cost = await busy(first, IDLE_MS);
    console.log(
      `ok  idle, paired and live, the engine's Worker was ${costLine(cost)} — the loop's quarter-second tick and its keepalive among it`,
    );
    const starved = await first.page.evaluate(STARVATION(chunk));
    console.log(
      `ok  a search beside a round trip — alone ${median(starved.alone).toFixed(1)} ms (median of ` +
        `${starved.alone.length}); during a ${starved.tripMs.toFixed(0)} ms trip, ${starved.beside.length} ` +
        `searches answered, median ${median(starved.beside).toFixed(1)} ms, slowest ` +
        `${Math.max(...starved.beside).toFixed(1)} ms`,
    );
  }

  // ---- the paired device relaunches, into its first ingest ----------------------------------
  // A paired device's launch is two things on the engine's one connection and one thread: the
  // launch's downloads — here a whole card file, thirty thousand cards, since this device has
  // none — and the loop's first act, a round trip, and then its socket. Nothing before this
  // step runs the two together: a first run is in no group, and a relaunch inside a day
  // downloads nothing. The first device writes meanwhile, so there is something to take.
  second.releaseCards();
  const beforeRelaunch = relay.log.length;
  const relaunched = Date.now();
  await second.relaunch();
  const wished = first.wish(RELAUNCH_WISH).then(() => first.closeCard());
  // Asked over and over from the moment the new document is up, and each answer timed: the
  // engine has one thread, so how long a read waits is how long the ingest — or a trip — kept
  // it. `live` and the end of the ingest are each when a read first said so.
  let liveAgain = null;
  let ingested = null;
  let slowest = 0;
  for (const stop = performance.now() + 120_000; ingested === null || liveAgain === null;) {
    second.hosts.check();
    const asked = performance.now();
    const live = await second.engine("sync_live_state");
    slowest = Math.max(slowest, performance.now() - asked);
    if (live === "live") liveAgain ??= Date.now();
    const status = await second.engine("sync_status");
    if (status.cardCount >= GROWN_CARDS && !status.syncing) ingested = status;
    if (performance.now() > stop) {
      fail(
        `${second.name} relaunched paired and never settled: it reads ${live}, and its card ` +
          `sync ${JSON.stringify(status)}`,
      );
    }
    await pause(50);
  }
  const ingestedAt = Date.now();
  await wished;
  if (ingested.lastError !== null)
    fail(`${second.name}'s card sync left ${JSON.stringify(ingested)}`);
  // A round trip opens with `/keys`, and this device's first one after the reload is its launch
  // trip — read off its own engine's requests, not the relay's log, where the other device's
  // trips are the same line (one run in eleven had one of those 14 ms after the reload).
  const tripAsked = second
    .events("Network.requestWillBeSent")
    .map((event) => ({ url: event.params.request.url, at: event.params.wallTime * 1000 }))
    .find((sent) => /\/keys(\?|$)/.test(sent.url) && sent.at >= relaunched);
  if (!tripAsked) fail(`${second.name} relaunched paired and its loop made no round trip`);
  // The relay's side of the same seconds: this device's socket is the one upgrade in them.
  const upgraded = relay.log.slice(beforeRelaunch).find((entry) => entry.status === 101);
  if (!upgraded) fail(`${second.name} reads live after its relaunch and the relay upgraded nobody`);
  await second.go("wishlist");
  await seen(
    second,
    `its wishlist drew ${RELAUNCH_WISH}, wished for on ${first.name} while it was relaunching`,
    second.draws(RELAUNCH_WISH),
  );
  const tookAt = Date.now();
  const relaunchLog = await second.engine("error_log_list", { limit: 50 });
  if (relaunchLog.length > 0)
    fail(`${second.name}'s relaunch logged: ${JSON.stringify(relaunchLog)}`);
  console.log(
    `ok  ${second.name} relaunched paired, into a first ingest of ${ingested.cardCount} cards — ` +
      `its launch trip asked the relay ${Math.round(tripAsked.at - relaunched)} ms after the reload, the ` +
      `relay upgraded its socket at ${upgraded.at - relaunched} ms, it read ` +
      `live at ${liveAgain - relaunched} ms and the ingest was done at ` +
      `${ingestedAt - relaunched} ms; the longest a read of the engine waited was ` +
      `${Math.round(slowest)} ms; and ${RELAUNCH_WISH}, wished for on ${first.name} ` +
      `meanwhile, was on its wishlist at ${tookAt - relaunched} ms. Nothing logged`,
  );

  // ---- the doorbell, phone to desktop ----------------------------------------------------
  const doorbell = async (writer, reader, card, any = false) => {
    await reader.go("wishlist");
    await seen(
      reader,
      "its wishlist page drew",
      `location.pathname === "/wishlist" && !${reader.draws(card)}`,
    );
    const mark = (await reader.told()).applied.length;
    const from = relay.log.length;
    const pressed = await writer.wish(card, any);
    // Where the write stopped, when it never arrives: on the writer, at the relay, in the
    // reader's engine, or between that engine and its page.
    const stoppedAt = async () =>
      `${writer.name} holds ${JSON.stringify(await writer.engine("sync_relay_status"))} and reads ` +
      `${await writer.engine("sync_live_state")}; the relay answered ` +
      `${
        relay.log
          .slice(from)
          .map((entry) => `${entry.method} ${shape(entry.path)} ${entry.status}`)
          .join(", ") || "nothing"
      }; ` +
      `${reader.name} reads ${await reader.engine("sync_live_state")}, was told ` +
      `${JSON.stringify((await reader.told()).applied.slice(mark))}, and its engine's wishlist holds ` +
      `${JSON.stringify(await reader.engine("wishlist_summary", { marketplace: "tcgplayer" }))}.`;
    const drawn = await seen(
      reader,
      `its wishlist drew ${card}, written on ${writer.name}`,
      reader.draws(card),
      stoppedAt,
    );
    const applied = (await reader.told()).applied.slice(mark);
    const told = applied.find((outcome) => outcome.changed);
    if (!told)
      fail(
        `${reader.name} drew ${card} and was never told sync:applied: ${JSON.stringify(applied)}`,
      );
    await writer.closeCard();
    console.log(
      `ok  ${writer.name} wished for ${card} and ${reader.name}'s wishlist drew it with nothing ` +
        `pressed there — ${drawn - pressed} ms from the press to the tile ` +
        `(sync:applied after ${told.at - pressed} ms: ${told.pulled} pulled, ${told.pushed} pushed)`,
    );
    return drawn - pressed;
  };
  // The second device wishes for the card and not for a printing: its corpus is the grown one,
  // and most of its printings of any card are ones the first device has never heard of.
  await doorbell(second, first, SECOND_WISH, true);
  await doorbell(first, second, FIRST_WISH);

  // ---- what the walk so far asked, and how it went ----------------------------------------
  // Read before the removal: a removed device's requests are refused on purpose, after it.
  const asked = [...relay.log];
  const preflights = asked.filter((entry) => entry.method === "OPTIONS");
  const requests = asked.filter((entry) => entry.method !== "OPTIONS");
  // **One refusal is the protocol at work, and it is told from every other.** The device that
  // confirms a pairing seals the key at the group's epoch and publishes the join's rotation a
  // moment later; the joiner's first trip is running in that moment, and now and then — three
  // runs in twenty-one here — the rotation lands between that trip's key check and its group
  // door. The relay then refuses, correctly, the auth of the epoch it has just left, and the
  // engine asks `/keys` and the door again (`token_across_a_rotation`, step 6.3b; before it the
  // trip failed there). Allowed only in that shape — behind a `/rotate`, and answered by a
  // `/keys` and a `/token` that is given — and only once.
  const acrossARotation = (entry) => {
    if (entry.method !== "POST" || entry.path !== "/token" || entry.status !== 401) return false;
    const at = requests.indexOf(entry);
    const rotated = requests
      .slice(Math.max(0, at - 3), at)
      .some((earlier) => /\/rotate$/.test(earlier.path) && earlier.status === 200);
    const later = requests.slice(at + 1);
    const again = later.findIndex((next) => next.method === "POST" && next.path === "/token");
    return (
      rotated &&
      again > 0 &&
      later[again].status === 200 &&
      later.slice(0, again).some((next) => next.method === "GET" && /\/keys$/.test(next.path))
    );
  };
  const refused = requests.filter(
    // The rendezvous poll's 404 is the relay's "not yet", which the engine waits through.
    (entry) => entry.status >= 400 && !(entry.status === 404 && /^\/p\//.test(entry.path)),
  );
  const reasked = refused.filter(acrossARotation);
  const refusals =
    reasked.length > 1 ? refused : refused.filter((entry) => !reasked.includes(entry));
  if (refusals.length > 0) {
    // Whose request it was, as that device's own engine saw it answered — and for `/token`,
    // which has two doors at one path, which door: a refusal is read differently on each.
    const asker = (entry) =>
      both
        .flatMap((dev) =>
          dev
            .events("Network.responseReceived")
            .filter(
              (event) =>
                event.params.response.status === entry.status &&
                event.params.response.url.split("?")[0].endsWith(entry.path.split("?")[0]),
            )
            .map((event) => {
              const body =
                dev
                  .events("Network.requestWillBeSent")
                  .find(
                    (sent) =>
                      sent.sessionId === event.sessionId &&
                      sent.params.requestId === event.params.requestId,
                  )?.params.request.postData ?? "";
              const door = /"refresh"/.test(body) ? ", the refresh door" : "";
              return `${dev.name}${/"auth"/.test(body) ? ", the group door" : door}`;
            }),
        )
        .join(" and ") || "a device the walk did not hear";
    const before = (entry) =>
      asked
        .slice(0, asked.indexOf(entry))
        .filter((earlier) => earlier.method !== "OPTIONS")
        .slice(-4)
        .map((earlier) => `${earlier.method} ${shape(earlier.path)} ${earlier.status}`)
        .join(", ");
    fail(
      `the relay refused: ${refusals
        .map(
          (entry) =>
            `${entry.method} ${shape(entry.path)} ${entry.status} (${asker(entry)}; ` +
            `${entry.at - asked[0].at} ms after the relay's first request, after ${before(entry)})`,
        )
        .join(", ")}`,
    );
  }
  const upgrades = requests.filter((entry) => entry.status === 101).length;
  const waited = requests.filter((entry) => entry.status === 404).length;
  const byRoute = new Map();
  for (const entry of requests) {
    const key = `${entry.method} ${shape(entry.path)}`;
    byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  }
  for (const dev of both) {
    const failures = dev.events("Network.loadingFailed").filter((event) => !event.params.canceled);
    if (failures.length > 0) {
      fail(
        `${dev.name} had requests fail: ${failures.map((event) => `${event.params.errorText} (${event.params.type})`).join(", ")}`,
      );
    }
    const errors = dev
      .events("Runtime.consoleAPICalled")
      .filter((event) => event.params.type === "error");
    if (errors.length > 0) {
      fail(
        `${dev.name} wrote errors to its console: ${errors.map((event) => event.params.args.map((arg) => arg.value ?? arg.description).join(" ")).join(" | ")}`,
      );
    }
    const log = await dev.engine("error_log_list", { limit: 50 });
    if (log.length > 0) fail(`${dev.name} logged: ${JSON.stringify(log)}`);
  }
  if (relay.said.length > 0) fail(`the relay said: ${relay.said.join(" | ")}`);
  console.log(
    `ok  no request failed and nothing was logged — the relay answered ${requests.length} requests ` +
      `and ${preflights.length} pre-flights (${upgrades} upgrades, ${waited} rendezvous polls answered not-yet): ` +
      [...byRoute].map(([route, count]) => `${route} × ${count}`).join(", ") +
      (reasked.length === 1
        ? ". One token was asked across the join's rotation: refused, and given at the next ask, under the new key"
        : ""),
  );

  // ---- the socket itself ------------------------------------------------------------------
  for (const dev of both) {
    const mine = dev.policy.sockets;
    const frames = (method) =>
      dev.events(method).map((event) => ({
        id: event.params.requestId,
        data: event.params.response.payloadData,
        at: event.params.timestamp,
      }));
    const sent = frames("Network.webSocketFrameSent");
    const received = frames("Network.webSocketFrameReceived");
    const answer = dev
      .events("Network.webSocketHandshakeResponseReceived")
      .map((event) => event.params.response);
    const selected = answer.map(
      (response) =>
        Object.entries(response.headers).find(
          ([header]) => header.toLowerCase() === "sec-websocket-protocol",
        )?.[1],
    );
    const pings = sent.filter((frame) => frame.data === "ping");
    const pongs = received.filter((frame) => frame.data === "pong");
    const heads = received.filter((frame) => frame.data.startsWith("{"));
    if (sent.some((frame) => frame.data !== "ping"))
      fail(`${dev.name} sent something that is not a keepalive: ${JSON.stringify(sent)}`);
    if (pings.length === 0 || pongs.length !== pings.length) {
      fail(`${dev.name} sent ${pings.length} pings and heard ${pongs.length} pongs`);
    }
    if (selected.some((protocol) => protocol !== "grimoire.live.v1")) {
      fail(`${dev.name}'s upgrade was answered with the sub-protocol ${JSON.stringify(selected)}`);
    }
    const gaps = pings.slice(1).map((ping, at) => Math.round(ping.at - pings[at].at));
    dev.socketLine =
      `${mine.length} socket${mine.length === 1 ? "" : "s"}, ${answer.map((response) => response.status).join("/")} ` +
      `selecting ${[...new Set(selected)].join()}, ${pings.length} ping${pings.length === 1 ? "" : "s"} each answered pong` +
      (gaps.length > 0 ? ` (${gaps.join(" s, ")} s apart)` : "") +
      `, ${heads.length} head frame${heads.length === 1 ? "" : "s"}`;
  }
  console.log(
    `ok  the sockets — ${first.name}: ${first.socketLine}; ${second.name}: ${second.socketLine}`,
  );

  // ---- the removal ------------------------------------------------------------------------
  await first.go("settings");
  await first.openSync();
  const saidBefore = (await second.told()).live.length;
  const removed = Date.now();
  await first.page.press(
    "the second device's Remove",
    `document.querySelector('button[aria-label^="Remove "]')`,
  );
  await first.page.press(
    "the dialog's Remove device",
    buttonSaying("Remove device", '[role="dialog"]'),
  );
  await first.engineUntil(
    "the roster holds one device again",
    "sync_pairing_status",
    (s) => s.devices.length === 1,
  );
  const rotated = Date.now();
  // **The relay tells the removed device, and nothing is pressed on it.** The rotation's roster
  // closes its socket with 4001; its loop backs off — `offline`, a second or a few — and then
  // does what a reconnect always starts with, a round trip, on which `/keys` answers a manifest
  // without it and it clears its own group; with no group there is nothing to dial for, and it
  // says `off`. (Until step 6.3b the relay closed nothing, and this step pressed Sync now.)
  const gone = await second.engineUntil(
    "the removed device read as in no group, with nothing pressed on it",
    "sync_pairing_status",
    (s) => s.groupId === null,
    30_000,
  );
  const learned = Date.now();
  await second.engineUntil("its loop said off", "sync_live_state", (s) => s === "off", 15_000);
  if (!second.lastSocketClosed()) fail(`${second.name} was removed and kept its socket`);
  const removedSaid = (await second.told()).live.slice(saidBefore).map((event) => event.state);
  if (removedSaid.join() !== "offline,connecting,off") {
    fail(`${second.name} was removed and said ${removedSaid.join(", ")}`);
  }
  // What it recorded of it: the removal, in one sentence, once — and nothing else is a failure
  // here. This device joined by pairing, so the row is also the walk's look at what the loop
  // records on one: until step 6.3b it asked `entitlement::membership_ended` alone, which
  // answers yes for every device that holds no refresh secret, and this log stayed empty.
  const removedLog = (await second.engine("error_log_list", { limit: 50 })).map(
    (row) => row.message,
  );
  if (removedLog.length !== 1 || !/no longer in its sync group/.test(removedLog[0])) {
    fail(
      `${second.name} was removed and its log holds ${JSON.stringify(removedLog)} — ` +
        "one row saying so was expected",
    );
  }
  // Its panel, opened now — a look, not a sync: this document has not drawn the Sync panel
  // since it relaunched, so what it reads is what the engine answers.
  await second.go("settings");
  await second.openSync();
  await second.page.until(
    "the removed device's panel reads not paired",
    `/not paired yet/.test(document.body.innerText)`,
    30_000,
  );
  const after = relay.log.slice(asked.length).filter((entry) => entry.method !== "OPTIONS");
  console.log(
    `ok  ${first.name} removed ${gone.deviceName} from the roster (${rotated - removed} ms), ` +
      `and ${second.name} read as in no group ${learned - removed} ms after the press, with ` +
      `nothing pressed on it — it said ${removedSaid.join(", ")}, its socket closed, and its ` +
      `log holds one row, "${removedLog[0]}". ` +
      "The relay's answers: " +
      [
        ...new Set(after.map((entry) => `${entry.method} ${shape(entry.path)} ${entry.status}`)),
      ].join(", "),
  );

  // ---- the policy, and what was listened to -----------------------------------------------
  // An issue is reported a moment after the act that raised it.
  await pause(500);
  for (const dev of both) {
    dev.hosts.check();
    const thrown = dev.page.thrown();
    if (thrown.length > 0) fail(`${dev.name} threw:\n${thrown.join("\n")}`);
    const watched = dev.policy.watched();
    const count = (kind) => watched.filter((target) => target.startsWith(`${kind} `)).length;
    if (count("worker") === 0 || count("service_worker") === 0) {
      fail(
        `${dev.name}'s policy was watched on ${watched.join(", ")} — no Worker, or no service worker`,
      );
    }
  }
  console.log(
    "ok  the host's Content-Security-Policy refused nothing on either device — its page, its " +
      "engine's Worker and its service worker — and neither page threw",
  );
  for (const dev of both) await dev.close();
}

await runAs("web-sync-smoke", DEADLINE_MS, main);
