# The light app, phase 6 — sync on light installs

Issue #761's phase 6: a light install — the Android app, a browser tab — is another device in the
group. It pairs by the same invite, compares the same six digits, takes one of the membership's
five slots, and keeps in step over the same socket the desktop uses. The design is
[the light-app spec](../specs/2026-10-01-light-app-android-and-web-design.md) §7; the record of
each step is [light-app.md](../../reference/light-app.md) §10.

> **For agentic workers:** each step is **one pull request**, opened with auto-merge and auto-fix
> armed. Tick a step here and on [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761)
> when its PR merges, and keep the issue's line current while a step is in flight.

## What the tree holds before it starts (surveyed 2026-10-04, `main` at `daa70e12`)

- **The pairing UI is already on the phone face.** Step 3.7 drew the desktop's own `SyncPanel` in
  the phone's Settings: *Pair a device* with its QR, *Enter a code*, *Scan a code* (`jsQR` over
  `getUserMedia`, falling back to typing), the six digits, the roster, *Leave group*, *Connect
  Patreon*. Android's manifest declares the camera. Nothing has driven it at phone width, and the
  phone face mounts nothing that hears `sync:applied`.
- **The relay answers no page.** `relay/src` has no `OPTIONS` arm and sends no `Access-Control-*`
  header; every sync request carries `authorization` or a JSON `content-type`, so each costs a
  pre-flight. `/g/{group}/ws` reads its bearer from the `Authorization` header, which a browser's
  `WebSocket` cannot set.
- **The engine refuses instead of asking.** On a host whose requests are a page's, every command
  that would reach the relay answers `NOT_FROM_A_BROWSER_YET` before anything is sent
  (`sync_engine::entitlement::not_from_a_page_yet`), and the hosting policy's `connect-src` leaves
  the relay out — a test holds its absence.
- **The socket's connection manager is the desktop crate's.** `src-tauri/src/sync_engine/live.rs`
  is `tokio` tasks, `tokio-tungstenite` and an `AppHandle`; every decision about *when* is already
  the core's (`sync_engine::schedule`). The Android host registers no write observer and starts
  no loop; the web host has no timer loop at all. `sync_live_state` is a desktop-only command.
- **The client reads no response header and sets two request headers** (`authorization`,
  `content-type: application/json`), on eight requests; one — `GET /p/{rv}/{slot}` — costs no
  pre-flight.
- **release-please already bumps all four crates and both `tauri.conf.json`s from one tag.**
  What a tag *builds* is the desktop alone.

## Decided before building

| Question | Answer |
| --- | --- |
| Polling, or the socket, in a browser | **The socket, on every host** (Markus, 2026-10-04: "I don't want the polling. The light app should use the sockets"). Spec §7's "none at first — pull on focus, on a timer and after a write" is not built, and the issue's last box — decide after living with polling — is settled before anything polled |
| How a browser presents its bearer on the upgrade | **In the sub-protocol**: the page offers `grimoire.live.v1` and `bearer.<token>`; the relay verifies the second exactly as it verifies the header and selects the first. The header form stays, for every desktop already released and for Android |
| A keepalive a browser can send | **The text frame `ping`**, answered `pong` by the Durable Object's auto-response without waking it. A browser cannot send a protocol ping, which is what the native client sends |
| The CORS allow-list | **A `vars` entry, `APP_ORIGINS`**, shipped as `https://mtg-grimoire.app` and nothing else. A local run points the engine at a local relay with its own list |
| Where the connection manager lives | **`grimoire-core`**, over a new `platform::socket` with a native arm (desktop and Android) and a browser arm. One loop, three hosts |
| Who deploys | **The agent building the phase, when a step needs it** (Markus, 2026-10-04: "you should deploy the changes we need, when we need them") — which reverses the issue's "no agent deploys anything" for this phase's deploys, and for nothing else. Each one is from `main` at a merged commit, with the runbook's probes run before and after and the deploy written down. One relay deploy carries the allow-list and the ticket; **the relay's deploy comes before the web app's**, because a page that asks a relay with no CORS answers fails every request |

## Global constraints

- **The desktop must not change**: the same requests, events, payloads, timings and `error_log`
  rows. A native client that sends no `Origin` gets the relay's answers byte for byte.
- **Nothing under `mobile/` asks where it is running**, comments included. What only a browser
  needs — the note about site data — is drawn from what the host answers below `@/lib/core`.
- **The core's five rules hold.** A socket is a `platform` arm; no `tokio`, clock or `cfg(target_…)`
  outside `platform/`.
- **No secret in the tree, and no deploy from a branch.** A deploy is of what `main` holds, after
  its pull request merged; a probe against the live relay before that is a read. The relay's D1
  holds real entitlements, so its deploy is an update and never a migration nobody reviewed.
- **A green suite proves the host it ran on.** The browser's half ends driven in a real browser
  against a relay standing on `localhost`; what only a phone or the deployed relay can show is
  written down as not seen.
- **Tests run once per step, after fan-in.**

## Steps — one PR each

- [x] **6.1 — the relay answers a page, and the engine asks it** (#818, merged 2026-10-04). `relay/`: `cors.ts` — the
  allow-list, the pre-flight ahead of every limiter, D1 read and Durable Object, and the header on
  every answer to an allowed origin, refusals included; `/ws` taking its bearer from the
  sub-protocol, refusing a foreign `Origin`, selecting `grimoire.live.v1`, and answering `ping`
  without waking. The engine's refusal and its sentence deleted, with the test that held them
  turned round: on a page the same commands do ask. `connect-src` names the relay and the test
  that held its absence becomes a row of the test that holds what is allowed. The runbook's
  step 0 gains a probe for each, marked not yet run.
  ([light-app.md](../../reference/light-app.md) §10.1 is the record.)
- [x] **6.2 — the live socket is the core's, and Android runs it** (#819, merged 2026-10-04). `platform::socket`, native
  arm; `sync_engine::live` in the core, emitting `sync:live` and `sync:applied` through the event
  sink; `sync_live_state` in the command table; the desktop keeping only its exit push; the
  Android host registering the write wake and starting the loop after its startup settles.
  ([light-app.md](../../reference/light-app.md) §10.2 is the record.)
- [x] **6.3 — the browser's socket** (#823, merged 2026-10-04). `platform::socket`'s browser arm — a `WebSocket` in the
  engine's Worker, the bearer in the sub-protocol, `ping` every 45 s; the web host starting the
  loop; whatever the hosting policy needs for `wss://`, measured in a browser first; a local relay
  — the relay's own `fetch` and `Group` under Node — and a smoke check that pairs two browser
  profiles through it and sees a write on one arrive on the other without a press.
  ([light-app.md](../../reference/light-app.md) §10.3 is the record.)
- [x] **6.3b — a device that left lets go of its socket** (#825, merged 2026-10-05). **A step
  the phase grew**, found by 6.3's own run: the loop asked about its group only between
  sockets, so a device that left, was removed or changed group went on holding the one it had.
  The loop lets go of a socket whose group its device is no longer in, and a rotation's roster
  closes the sockets of the devices it leaves out, with a close code of its own, 4002.
  ([light-app.md](../../reference/light-app.md) §10.3b is the record.)
- [x] **6.4 — pairing on the phone face** (#820, merged 2026-10-04). The panel measured at 360, 412 and 800 wide and fixed
  where it overflows; the scanner driven with a fake camera; `sync:applied` heard on the phone
  face; the note that clearing site data mints a new device and spends a slot, in the panel and
  in every confirm that would destroy the identity.
  ([light-app.md](../../reference/light-app.md) §10.4 is the record.)
- [x] **6.5 — an unpaged `pull` in a Worker, measured** (#824, merged 2026-10-05). A large import pushed by one device and
  pulled by a browser through the local relay: the response's size, the Worker's peak memory, the
  time the engine is deaf to the page. Paging is built only if the figures ask for it.
  **They asked for it** — 44.6 MB in one answer, the engine deaf for 29 s, 570 MB of linear
  memory. ([light-app.md](../../reference/light-app.md) §10.5 is the record.)
- [x] **6.5b — the pull is paged** (#829, merged 2026-10-05). **The second step the phase
  grew**: 6.5's figures asked for paging, and the owner decided to build it in this phase
  rather than leave it to the next. The relay answers a page, and streams the unpaged answer
  every released build still asks for; the engine fetches a catch-up in pages, classifies it,
  and applies it a page at a time.
  ([light-app.md](../../reference/light-app.md) §10.5b is the record.)
- [x] **6.6 — the release rule** (#821, merged 2026-10-04). What ships from a tag, for all three hosts, and what holds a
  group's devices to one schema version.
  ([light-app.md](../../reference/light-app.md) §10.6 is the record.)

**Phase 6 is complete (2026-10-05)**: eight pull requests, and two deploys of each Worker
([light-app.md](../../reference/light-app.md) §10.7).

## Built differently from this plan

- **The browser got a smoke of its own, with the relay under workerd.** Step 6.3 planned a local
  relay that was "the relay's own `fetch` and `Group` under Node". What was built is
  `npm run web:sync-smoke`: the relay's code under `wrangler dev --local` — the runtime it is
  deployed on, with a local D1 and the group's own Durable Object — and two browser profiles that claim,
  pair and sync through it.
- **Paging was built, and its client classifies first.** Step 6.5 said paging is built only if
  the figures ask; they did, and step 6.5b built it. The client fetches the whole catch-up and
  looks into it before applying anything, because a page edge would lose rows from the
  baseline of an emitter older than v0.40.0 — such a catch-up is evaluated as the one answer it
  used to be.
- **Two deploys of each Worker, where the table planned one relay deploy.** The first pair
  (2026-10-04) carried step 6.1's relay and step 6.3's engine; the second (2026-10-05) carried
  6.3b and 6.5b on both.

## What only Markus can close

- ~~**Production pairing**~~ — **done, by his word**: on 2026-10-05 he paired the deployed web
  app with a desktop and synced between them — "it works".
- **The release rule's owner list**: the `release` environment restricted to `main`, the
  keystore and its committed fingerprint, the environment's values
  ([ci-and-releases.md](../../reference/ci-and-releases.md), *What only the owner can do*).
- **A real phone**: the camera grant in the Android WebView, a scan of a desktop's QR, a socket
  that survives the app going to the background and coming back.
- **A second real browser**: Safari and Firefox open the socket with a sub-protocol too, and
  neither has been driven.
