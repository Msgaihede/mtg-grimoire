# `infrastructure/app-worker/` — the web app's hosting

A third Cloudflare Worker, beside `infrastructure/relay/` and `infrastructure/share-worker/`. It serves the light app's web
build — `apps/light/dist-web/`, the page and the engine compiled to WASM — at **`https://mtg-grimoire.app`**,
the origin root. It is static assets, one file of response headers, and a script of a few lines.

**It is deployed there since 2026-10-04** — first at 12:47 UTC, from `main` at `d8c3779b`, with
every probe of step 0 asked of the real address a minute later. **The last deploy was 2026-10-05 at
02:29:39 UTC, from `main` at `117827d2`** (through #829) — the fifth build: the engine of
steps 6.3b and 6.5b, which lets go of a socket it has no group for and pulls in pages, eight
minutes after the relay that answers a page — so production is `main`'s code as of that
commit. Before it: 23:19:22 UTC on 2026-10-04 from `2bbd4446` (through #824), the fourth build
and the first whose engine asks the relay from a page and whose policy lets it — step 6.3's
engine and the `wss://` source; 13:43 UTC from `e1e76f78`, the third build and the first to rename chunks;
and between the first and that, a build from `4929cc6e` went
out at 13:27 and was rolled back at 13:28 and forward again at 13:30, to see a rollback work.
This paragraph said *nothing is deployed there* until that day. **Ask the host before you
believe it or its opposite.** This directory is source, configuration and a runbook; `wrangler
deploy` is Markus's, and each of those was run by an agent because he asked for it. The design is
[the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md) §6,
and the build it serves is [light-app.md](../../docs/reference/light-app.md) §9 — whose §9.7 is the
deploy's own record, with what it has not proved.

| File | What it is |
| --- | --- |
| `wrangler.jsonc` | The Worker: its name, the custom domain, the `assets` binding over `../../apps/light/dist-web` |
| `_headers` | The response headers, in Cloudflare's format. The web build copies it into `apps/light/dist-web/` |
| `package.json`, `package-lock.json` | The one tool that deploys this Worker — `wrangler`, at an exact version — and every package under it with its integrity hash. Not a workspace of the root package (*Deploying*) |
| `src/index.ts` | The script: a missing file is a 404, never the document |
| `src/headers.ts` | A reader of `_headers` that answers as Cloudflare's does — for the preview and the tests |
| `src/hosting.test.ts` | The fence between the policy and the hosts the engine asks |

## Why it is not a route on either of the other two

**Blast radius**, the reason `infrastructure/share-worker/` gives for itself. Sync is a paid feature people
depend on, the relay's deploys are done by hand by one person, and a deploy of a *page* happens
far more often than a deploy of the relay — at every release, by a job, since 2026-10-04
(*Deploying*). One Worker carrying both makes a bad build of the app a
sync outage.

And unlike those two it shares nothing: **no D1, no R2, no KV, no Durable Object, no `vars`, and
no secret.** The whole of what it can read is the files a build wrote, which are public by being
served. A compromise of this Worker is a compromise of a web page — serious, because the page
holds a reader's collection in their browser, but it reaches no key, no token and no other
reader's data.

## What is public, and what is not here to leak

- **The origin, `https://mtg-grimoire.app`, is public and is in this repository** — on the terms
  `RELAY_BASE` is: it is the address every reader types.
- **`wrangler.jsonc` and `_headers` are public.** A policy is not a secret; a browser prints it.
- **There is nothing to set with `wrangler secret put`**, and no `.dev.vars` belongs here. What
  keeps one — or wrangler's `.wrangler/` state — out of a commit is the root `.gitignore`, which
  ignores both everywhere; `hosting.test.ts` sweeps this directory's dotfiles too, but it can
  only see one on the machine that has it.
- **The Cloudflare account id is in no file of this repository** — wrangler takes it from the
  login — and `hosting.test.ts` fails if anything shaped like one appears in this directory.

## What it answers

| Request | Answer | Who answers |
| --- | --- | --- |
| A file that exists — `/`, `/assets/…`, `/wasm/<build>/…`, the manifest, `/sw.js` | the file, with `_headers` applied | the edge; **the script does not run and the request is free** |
| A browser's navigation to a place in the app — `/decks/12` | the document, 200, with `_headers` applied | the edge, the same way |
| Anything else that matches no file — a chunk a deploy renamed | **404**, `text/plain`, `no-store` | the script |
| A card picture, `/mtgimg/…`, from a page no service worker controls yet | **404**, `no-store` — whatever the caller accepts | the script |
| A navigation that did not say so — `curl -H "Accept: text/html" /decks/12` | the document, 200, with `_headers` applied | the script, through the binding |
| `/_headers` itself | **404** — the file is parsed, not served | the script |

**Where "the script" answers, the answer depends on the account's day.** Once the free plan's
100,000 Worker requests are spent, Cloudflare answers every request it would have handed to the
script with a `429 text/html` of its own — *Cost*, below, has the source. A file that exists and
a browser's navigation are untouched.

**The third row is the reason there is a script at all.** `not_found_handling:
"single-page-application"` answers every address that matches no file with `index.html` and a 200
— which `/decks/12` needs and `/assets/DeckPage-3f9a.js` must never get. A page loaded before a
deploy asks for its old chunk; handed HTML with a 200 it reports a MIME error instead of the failed
import the app is built to recover from, and a service worker has no reason not to keep the
response. Configuration cannot say "the document for a place, a 404 for a file". With a script
present, Cloudflare's own split does (verified in the docs, below): a request carrying
`Sec-Fetch-Mode: navigate` is answered with the document before any code runs, and every other
miss reaches the script.

**What "a navigation" is differs by who is asking, and both rules are deliberate.** Cloudflare's
is the header a browser sends. The script's, for the clients that send none, is `isNavigation` in
`packages/ui/lib/core/web/assets.ts` — a `GET` that accepts `text/html`, for a path whose last segment
has no extension — which is the rule `npm run web:dev` and `web:preview` serve by, imported so the
three cannot come to disagree.

**Three trees hold no place at all**: under `/assets/`, `/wasm/` and `/mtgimg/` the script
answers a miss with the 404 whatever the caller accepts. The third is step 5.3's: card pictures
are asked of this origin at `/mtgimg/…` and answered by the service worker, so a page that worker
does not control yet asks the network — and the document there would be drawn as a broken picture,
with a 200 a cache has no reason to refuse. An `<img>`'s request is `Sec-Fetch-Mode: no-cors`, so
the edge never gives it the fallback; the tree is named in the script so that the script cannot
either, for a path whose last segment happens to have no extension.

⚠️ **A browser that *navigates* to a missing file gets the document**, by Cloudflare's rule:
typing `/assets/gone.js`, `/mtgimg/display/abc/0` or `/_headers` into the address bar shows the
app. Nothing in the app navigates to a file or a picture, so nothing is handed HTML where it asked
for code or pixels; it is written down so the probe below does not read as a bug. **Under
`/assets/` and `/wasm/` that document is sent with the tree's own caching** — `_headers` is
matched on the address asked, so it is the app's HTML marked `immutable` for a year at an address
nothing links to. Harmless, and odd enough to be worth knowing before it is seen in a cache.
**The one setting that could close all of this is not taken**: `run_worker_first` with a list of
patterns "disables the automatic `Sec-Fetch-Mode: navigate` detection" (the
single-page-application page) — in the asset worker's source, a list makes `canFetch` keep the
fallback for *every* request, so a missing chunk would be answered with the document again — and
a request it matches is a 429 once the free plan's day is spent.

## The policy

`_headers` carries the reason for each line at the line. What is worth knowing before changing it:

- **One Content-Security-Policy, sent with every response — the scripts too.** Measured in
  headless Chrome 154.0.8037.95 on 2026-10-04, against this build with one header changed at a
  time: a dedicated Worker is governed by the policy on **its own script's response**, not the
  page's. With the document's policy stripped of `'wasm-unsafe-eval'` the engine still compiled;
  with the Worker chunk's stripped, it failed with a `CompileError`; with the chunk sent
  `default-src 'none'`, it could not import the engine's glue. With `api.scryfall.com` removed
  from the document's `connect-src` alone the Worker still asked it; removed from every
  response, each request was refused. A service worker is the same: its `fetch` is held to the
  policy on `sw.js`'s response, and a `sw.js` sent with none is held to nothing. So the database
  Worker's chunk and `/sw.js` must carry the policy, and `/*` is how.
- ⚠️ **So a change of policy has to reach the Worker's script, and one hashed file is therefore
  not `immutable`.** `assets/worker-<hash>.js` is content-addressed like its neighbours, but the
  policy it runs under is this file's, not its own bytes'. A deploy that changes only `_headers`
  renames nothing — and measured, in the same Chrome, with a Worker script whose address and
  bytes stay put while the server changes the policy sent with it:

  | The script's `Cache-Control` | On the next visit | The Worker runs under |
  | --- | --- | --- |
  | a year, `immutable` | not requested at all | **the old policy** |
  | `no-cache`, and the 304 carries the new policy | a conditional request | the new policy |
  | `no-cache`, and the 304 carries no policy | a conditional request | the old policy |

  So the chunk has a rule of its own, after `/assets/*`: `no-cache`. It is a few kilobytes and
  answers 304, and Cloudflare's 304 carries `_headers` — `handleRequest` in the asset worker's
  source wraps every response it returns, the `NotModifiedResponse` included, in
  `attachCustomHeaders`. Without the rule, "one host in `_headers` and a deploy" would have fixed
  new visitors and nobody who had been before; the relay's host, added for sync, is the same
  trap. The rule is written for the name Vite gives the chunk, and `hosting.test.ts` reads the
  line that constructs the Worker so a renamed file is a failure there. **The service worker is a second
  cache with the same property** (step 5.3): it serves the shell, this chunk included, out of
  Cache Storage with the headers it was stored with. That step re-fetches the shell per build and
  hashes `_headers` into its build id, so a policy change is a new build to it — a property of
  that step, pinned by a test there (`packages/ui/lib/core/web/sw/shell.test.ts`, *moves when only the
  host's `_headers` changed*), and not something this directory relies on or checks.
- **`connect-src` is exactly the hosts the engine asks, and `hosting.test.ts` holds it there in
  two halves.** *A host that moved*: the engine's addresses are read by name — `SCRYFALL_API`,
  `IMAGE_HOST`, `FEED_URL`, Card Kingdom's `url()` and the sync relay's `RELAY_BASE` — and the
  policy is held set-equal to their hosts and the bulk files', so a missing entry and an extra
  one are both red. *A host that is new*: a census of every
  `https://` literal in the code the three crates **ship** (above each file's test modules, by
  the cut `crates/grimoire-core/CLAUDE.md` states; comments out), each of which must be in
  `connect-src` or on a short list of hosts a browser's engine never asks, with a reason apiece —
  Mana Pool, Patreon's authorize page, the repository's address in the `User-Agent`, the
  scanner's debug page. A sixth feed in a file the test has never heard of is red. **Not Mana
  Pool** (it sends no `Access-Control-Allow-Origin`, so a page cannot read it whatever a policy
  says).
- **The relay is in `connect-src`, and it is the one host there that answers this origin by
  name.** The engine asks it from a page as it does from any host — pairing, the Patreon claim,
  push, pull, the key check — and each of those is a cross-origin `fetch`; all but the
  pairing poll carry `authorization` or a JSON `content-type`, and so cost a pre-flight. The
  relay answers that pre-flight, and stamps every answer after it, only for an origin on its
  own allow-list
  (`infrastructure/relay/src/cors.ts`; `APP_ORIGINS` in `infrastructure/relay/wrangler.jsonc`). **So this entry and that list
  are one fact written in two deploys**, and neither is any use without the other: a policy
  that names a relay that does not answer lets every request leave and fail, and a relay that
  answers an origin whose policy does not name it is never asked. *The steps, in order* has
  the order. **It is named twice — `https://` for its requests and `wss://` for the live
  socket — because to `connect-src` those are two sources.** Measured in headless Chrome 154
  on 2026-10-04, in a page and in a dedicated Worker alike: under `connect-src 'self'
  https://<relay>` a `new WebSocket("wss://<relay>/g/…/ws?device=…")` is refused before
  anything is sent — the console says *Connecting to 'wss://…' violates the following Content
  Security Policy directive: "connect-src 'self' https://…". The action has been blocked.* —
  and the socket fires `error` and no `close`. With `wss://<relay>` beside it the upgrade
  reaches the relay. So that one source is written, derived from `RELAY_BASE` by the rule the
  engine dials by (`platform::socket`'s `ws_origin`), and `hosting.test.ts` holds it: every
  other source is `https://`, this is the only `wss://`, and a relay that moves is red until
  both follow. ⚠️ **It names the hosted relay and no other**: the engine's override
  for a relay of a reader's own (`client::RELAY_URL`, which has no UI) points a request at a
  host this policy refuses, so the hosted page syncs through the hosted relay or not at all.
- ⚠️ **What the fence cannot hold: `data.scryfall.io`, which is Scryfall's choice and no line
  of ours.** The card sync and both Tagger feeds download whatever address Scryfall's descriptor
  names; no shipped line says the host, and the census has a test saying so. The fence reads it
  from descriptors transcribed into two *test* modules, which pins the policy to what Scryfall
  sent on the day those were written. The desktop follows the descriptor anywhere; a browser
  under this policy follows it only to that host. If Scryfall moves its bulk files, every suite
  stays green and the web app's first run fails — the page says `http request failed: error
  sending request`, the console has the violation — while the desktop keeps working. The fix is
  one host in `_headers` and a deploy, and the rule above is what makes that deploy reach a
  reader who has been before. The same is true of any address that is built, configured or sent
  rather than written.
- **`img-src` is this origin and `data:`, and does not name `cards.scryfall.io`** — though every
  card picture comes from there. Step 5.3's service worker answers a picture at `/mtgimg/…` with
  Scryfall's bytes, and **it has to hand back a response rebuilt from those bytes**. Measured the
  same day, on two `localhost` origins: with `img-src 'self'` alone, Chrome **blocks** the picture
  when the service worker returns Scryfall's response as it came — fetched, opaque, or out of
  Cache Storage, under either key — because the check is made against the *response's* address as
  well as the one the page asked. Only `new Response(bytes)` was drawn. That is what 5.3 builds, so
  the host stays out: the policy is tighter, and a service worker that ever stops rebuilding goes
  wrong where it can be seen. It is in `connect-src`, which is what that worker's `fetch` needs.
  (The first commit of this file named the host in `img-src`, before 5.3 was built to rebuild.)
- **`style-src 'self'`, with the desktop's `style-src-attr 'unsafe-inline'`.** The same
  components run here; `packages/ui/CLAUDE.md` has what the first forbids. `hosting.test.ts` holds each
  directive the two hosts share to the desktop's shipped policy, so this one is never the looser.
  ⚠️ **One surface is known to be refused by it on the live site**: the deck note editor, whose
  library adds a `<style>` element of its own — *What the browser said under it*, 2026-10-04.
  The answer to that is in the component, not here — **and is there since that day
  (`injectCSS: false`), in no build that has been deployed.**
- **Caching is a default, two trees, and two files.** Everything is `no-cache` — kept, and asked
  about every time: the document, the manifest, the favicon and the manifest's `icons/*.png`,
  whose names carry no hash, so a year for them would be a year an installed app kept an old
  icon. `/assets/*` and `/wasm/*` are content-addressed and kept for a year — less the engine's
  Worker, above. `/sw.js` restates the default by a rule of its own, so loosening `/*` cannot
  take it along. ⚠️ **A header two matching rules both set is joined with a comma**, so each
  narrower rule detaches first (`! Cache-Control`); and **two rules for one path are not two
  rules** — Cloudflare stores them by path and keeps the last — so `src/headers.ts` refuses a
  file that repeats one, and a rule with nothing under it.
- **No isolation headers.** The OPFS pool needs neither `Cross-Origin-Opener-Policy` nor
  `-Embedder-Policy`, and `require-corp` would refuse every card picture.

**`npm run web:preview` sends the same headers**, read from the built `apps/light/dist-web/_headers` by
`src/headers.ts`, answers a missing file with a bare 404 as the script does, and answers
`/_headers` itself with a 404, as the host does. The dev server sends none of it: Vite injects
`<style>` elements and talks over a WebSocket, which the policy forbids on purpose.

### What the browser said under it

Headless Chrome 154.0.8037.95 on Windows 11, 2026-10-04, over `npm run web:build` of `main` at
`92cbc02b` with this directory merged in. **The module was a copy, not this tree's own build**:
8,623,589 bytes, taken from the phase's working tree that day (3.07 MB gzipped by Vite's
report).

- **A first run, under the policy.** A scratch copy of `scripts/web-smoke.mjs` that serves
  `apps/light/dist-web/` through `headersFor` and listens for violations on the page and in the Worker —
  the repository's script does neither. All nine of its checks passed: the engine compiled and
  opened its database, the card sync asked `api.scryfall.com` and followed the descriptor to
  `data.scryfall.io`, both Tagger files and the combos finished with rows stored, a typed search
  drew a tile, Settings downloaded Card Kingdom's pricelist, a reload kept the cards, a second
  tab was told. **Every host in `connect-src` was asked and let through.**
- **The one violation, seventeen times: `img-src` refusing `http://mtgimg.localhost/…`.** On
  `main` the page still names the desktop's image protocol; step 5.3 moves pictures to
  `/mtgimg/…` on this origin. Until it lands, a card picture in a browser is blocked by this
  policy where before it was a connection nobody accepted — the tile draws its retry either way.
  (**True of the tree that run was made on.** Step 5.3 has since landed beside this directory:
  the page asks `/mtgimg/…` and the service worker answers. That run has not been made again, so
  no card picture has yet been seen drawn under this policy.) **Answered since, twice**: the
  phase's own run drew them under this policy on `localhost` (light-app.md §9.6), and the run at
  the real origin, below, drew them there.
- **That count is not a vacuous one.** The same run with `data.scryfall.io` taken out of
  `connect-src` failed at the card sync — the page said `http request failed: error sending
  request` — and reported the Worker's three refused downloads by name. That sentence is also
  what a reader sees on the day Scryfall moves its bulk files.
- **Both faces, as deep links**, through `npm run web:preview` with real hosts unresolvable: at
  360 × 800 and 1280 × 800, each of `/search`, `/collection`, `/decks`, `/wishlist` and
  `/settings` reached its shell with no violation and nothing thrown, and the console said
  `database open in OPFS — journal delete, corpus journal delete, schema 59` every time.

**What stayed unexercised**: the desktop face over a corpus — the fixtures drive the phone face,
and at 1280 the empty database shows its *No card data yet* wall rather than a table, a dialog or
a menu; a card picture actually drawn; a service worker; any browser but this one. (**Of that
run.** The first three have been driven since — §9.6 on `localhost`, and the run below.)

**At the real origin, 2026-10-04, started 12:50 UTC** — three minutes after the first deploy.
The same headless Chrome, 154.0.8037.95 on Windows, a fresh temporary profile, listening only,
against `https://mtg-grimoire.app` serving engine build `6d63009f7fa1062b`. **One pass, one
run**; light-app.md §9.7 has every figure.

- **Zero policy violations** — on the page, in three sessions of the engine's Worker and in the
  service worker — with no request blocked or failed, no console error and nothing thrown. The
  console said `database open in OPFS — journal delete, corpus journal delete, schema 59`.
- **The first run against the real hosts, from this origin, finished**: 118,470 cards
  searchable at 21.4 s, and every launch feed in at 44.1 s, with the error log empty. **Every
  host in `connect-src` was asked and answered 200** — the engine's Worker asked
  `api.scryfall.com`, `data.scryfall.io`, `json.commanderspellbook.com` and
  `api.cardkingdom.com`, the service worker asked `cards.scryfall.io` — **and the app asked no
  host outside it.** That is the hosts' own CORS answer to this origin, which no fixture and no
  `localhost` could give.
- **Card pictures were drawn under the policy as the host sends it**: the phone face's first
  wall and a typed search, every picture asked of `/mtgimg/display/…` on this origin and
  answered 200 by the service worker, each stored as `image/webp`; and the desktop face's wall
  at 1280 × 800. An uncached picture took a median of 995 ms against 402 ms in §9.6's local
  run — Scryfall's share of that not separated.
- **The service worker took control on the first visit** and precached the shell, every request
  a 200; a deep link to `/decks` in the same profile was answered by it; and **a launch with no
  name resolvable opened the app**, with its cached pictures drawn and *Retrying…* over the
  worker's 502 for one never cached.
- **The document the browser was served was the built one, byte for byte**, with one `<script>`
  in the HTML and in the live DOM, and none of the zone features' marks in either.
- **Chrome was sent `zstd`, not the brotli `curl` was**: the module was 2,176,146 bytes on the
  wire.
- **Settings → Sync → *Pair a device*** drew the engine's refusal sentence and made **no
  cross-origin request** — so the relay's absence from `connect-src` was never what a reader
  met. (**True of that build, which is what production still serves.** The engine no longer
  refuses and the policy names the relay — *The policy*, above. No build that asks the relay
  from a page has been deployed, so that press has not been seen at the real origin since.)

**Not driven in that pass**, and driven later the same day, next: the update flow, which needed
a second deploy; a second tab; a launch after storage was cleared; decks, import and export, a
context menu, an *Open on …* link; the engine asked to fetch with no network.

**The rest, the same day** — headless Chrome 154 again, one fresh profile, the real hosts, on
the first deploy's build; then one tab held open across the three deploys of *Rolling back*.
light-app.md §9.7 has every figure. **Across both sessions: no policy violation, no request
blocked or failed while online, and nothing thrown.**

- **A second tab is told at once and starts no engine** — at 130 ms with the first tab in the
  middle of its first run, at 87 ms with it idle — and its *Reload* opens the app once the
  first has closed.
- **A reload that lands inside the real card sync's finish opens again**, on the fifth ask,
  about four seconds after the first. ⚠️ The interrupted finish left no cards, so the new
  document downloaded the card file again.
- **A launch after the browser cleared the app's storage** drew its notice and rebuilt the
  corpus by itself.
- **Every reader task on both faces worked**, decks, import, export and the *Open on …* links
  among them.
- **With no network the app opens from the service worker**, and a refresh the reader presses
  fails with an alert and a line in the log. ⚠️ The alert is the engine's raw words — *http
  request failed: error sending request* — not a sentence written for a reader.
- **Nothing stands in the way of an install by Chrome's own check**: no installability error,
  the manifest served as `application/manifest+json` with the policy, every icon a 200. No
  install was made; headless Chrome has no install UI.
- **A build deployed under an open page is offered, and taken only on the reader's press** —
  three times, with the reader's data intact each time. *What a deploy changes for a reader*,
  below, has what it cost.
- **`/favicon.ico` answers 404.** The app's document names an SVG icon, so a browser asks for
  the `.ico` only when it opens a document of this origin that is not the app's — and by the
  split in *What it answers* that miss is the script's, a Worker request each time.

**And outside that Chrome: the owner used the live site in Firefox that day** and reported one
sentence — *"it works fine. multiple tabs locks the user out until the first tab is closed."*
No version and no figure; it is the only word there is from a second engine. **And on a phone**:
*"i tested on a phone too. looks good."* — no phone, browser or figure named.

**Across the final deploy, 13:43 UTC the same day** — the first to rename chunks, with two
headless Chrome 154 browsers held open over it. *What a deploy changes for a reader*, below,
has what each met. **It also found the one policy violation known on the live site**:

- ⚠️ **Opening the deck note editor — *New note* — raises two `style-src-elem` violations.**
  An inline `<style>` element, refused by `style-src 'self'`. On the build before the deploy
  and the build after it alike, so the deploy did not bring it.
- **The editor opened all the same**, drew its toolbar and took typing. ~~What the refused
  styles would have changed was not looked at.~~ **Nothing on screen: ProseMirror's own sheet
  is bundled, and the refused one is those rules again.**
- **The cause, read and not run**: the editor's library is Tiptap, whose `injectCSS` option
  defaults to true and makes it add a style tag of its own
  (`node_modules/@tiptap/core/dist/index.js`); `packages/ui/features/decks/NoteEditor.tsx`'s
  `useEditor` does not set it.
- **No earlier pass saw it because none opened that editor.** Each "no policy violation" above
  stands for the surfaces its pass drew, and this is the surface none of them drew.
- ⚠️ **The fix is in the component and never in this policy.** `style-src 'self'` is the
  desktop's rule, held equal by `hosting.test.ts` — so the packaged desktop presumably refuses
  the same element, ~~which nobody has checked. Found, not fixed here: handed off as its own
  task.~~ **Checked the same day: it does, once for each editor built. Fixed in
  `NoteEditor.tsx`, fenced in `tokens.test.ts`, and asked on every `web:smoke` since — which
  opens a note under this policy.** ⚠️ **The deployed build still raises it**, until a deploy
  carries the fix — and that is the owner's to ask for.
  [light-app.md](../../docs/reference/light-app.md) §9.7 has each measurement.

**Still not driven at the real origin**: the app's *own* check for a new build, in any browser
that was measured — the owner's Firefox drew its notice once, by his sentence, and in Chrome
the app's hourly limit held it every time; a page with no controller at all; an installed
app; Safari; a phone's first run with a clock on it.

## Deploying

**Two ways, and one rule over both: the web app is never ahead of the last release.** Sync
stamps every op with the sender's user schema, and a desktop on the last release *holds* an op
stamped newer until it updates — so a web app deployed from a `main` that has moved the schema
sends every paired desktop ops with no update to install. One core means one schema per commit,
and the three hosts ship from one tag ([ci-and-releases.md](../../docs/reference/ci-and-releases.md),
*The release rule*).

- **At a release, a job deploys it** (decided by the owner, 2026-10-04). `release.yml`'s `web`
  job builds the bundle at the tag and opens it in a browser — steps 1 to 4 below, as CI's
  `web` job runs them — and `web-deploy` then installs `wrangler` from this directory's
  lockfile with no script run, and runs **`npx --no-install wrangler deploy`** from here with a
  token from the `release` environment, which only `main` may use. It then asks the real
  address three things: the document answers 200, its policy is the built `_headers` line, and
  the document is the bundle's (`scripts/web-deploy-probe.mjs` — probe 1 below, and the
  document check beside the table). It runs after the desktop builds and the APK and before
  the release is published, and it refuses a tag older than the newest published release — a
  re-run of an old release's job must not put an old bundle back. **It is the only job in this
  repository that deploys anything, and this is the only Worker it deploys — so merging the
  release PR is a deploy.** Without `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in that
  environment it deploys nothing and says so in the run's summary — and then this address
  serves the previous deploy until somebody follows the steps below from the tag. ⚠️ **The job does not do step 5,
  asks the relay nothing, and runs three of step 0's questions, not its twenty probes**: a release whose
  web build needs new relay behaviour needs **the relay deployed first, by hand, before the
  release PR is merged**, and the full table is still somebody's to run after a release that
  changed `_headers`, `wrangler.jsonc` or the script. **No release has run it yet.**
- **Between releases, by hand** — the rest of this section. Step 6 of *The steps, in order* is
  the rule's guard for this way: `npm run web:deploy-guard`.

⚠️ **No agent runs `wrangler deploy`, or any wrangler command that reaches Cloudflare.** That is
the repo owner's, as it is for the other two Workers.

**`wrangler` is pinned by this directory's lockfile, and that is the one every deploy runs.**
`package.json` here names `wrangler` at an exact version and nothing else, and
`package-lock.json` names all ninety-one packages under it, each with the registry's integrity
hash. It is not a dependency of the app — this directory is not a workspace of the root
package, so the root's `npm ci` installs none of it. Before any command below:

```
npm ci --ignore-scripts --prefix infrastructure/app-worker     # from the repository root; no lifecycle script runs
cd infrastructure/app-worker && npx --no-install wrangler --version     # 4.146.0, or it fails
```

**Every `wrangler` below is `npx --no-install wrangler`**: what runs is what that lockfile
installed, or nothing — never whatever `npx` would fetch that day. Until 2026-10-04 this
runbook said `npx wrangler`, which fetched the latest, and the release job said
`npx wrangler@4.146.0`, which pinned one package and let ninety resolve on the day, two of
them running a `postinstall`. `--ignore-scripts` costs nothing: `esbuild`'s and `workerd`'s
scripts only swap a launcher for the binary it starts (a `deploy --dry-run` after such an
install was run that day, on Windows). Moving the version is `npm install --package-lock-only
--ignore-scripts wrangler@<version> --prefix infrastructure/app-worker` and a pull request with both files.

**The 2026-10-04 deploy was run by an agent because Markus asked
for it in chat**, as he did for the relay's on 2026-10-01 — and **the ask is per deploy**: it
lifted this rule for that one deploy and left it standing for the next. The second deploy that
day, and the rollback and roll-forward after it, were asked for again — he approved a marker
deploy and a rollback test through the question tool — and so was the third, in chat: *"go
ahead and run the deploy"*. Nothing else was run. **For the light app's phase 6 he asked once
for the phase** (2026-10-04: *"you should deploy the changes we need, when we need them"*): the
relay's deploy and this Worker's, as that phase's steps need them, and nothing after it. **The
deploy of 23:19 UTC that day was run under that standing ask** — after the relay's, at 17:22,
and only once probe 20 had answered `204` with the allow-origin line — **and so was the one of
2026-10-05 at 02:29 UTC**, after the relay's at 02:21. The steps below bind
whoever runs them.

### Step 0 — ask the host, never a document

`infrastructure/relay/README.md` was wrong twice in one week about what was deployed, and five files once agreed
the relay did not exist while it was answering requests. The only sentence that cannot rot is a
`curl`. **The *Answered* column is what the real address said on 2026-10-04 at 12:48 UTC** — a
minute after the first deploy, asked with `curl` from one machine in Denmark, of version
`cdee3c1c-d3ae-4246-8e8a-c50eb3025152`: `main` at `d8c3779b`, engine build id `6d63009f7fa1062b`.
(Until that day the column read *not yet run* in every row, and this paragraph said there was
nothing at the address to ask.) **It is that minute's answer and no later one's.** Run them again
before believing this file or its opposite, and after every deploy, and write the answers in here
with the date.

**Production has moved four times since the column was written, and the probes were asked again
each time.** The fourth is what production serves, and is the last bullet.

- **Version `f724bbc1-9853-4978-9ffe-8b3c0af6c339`**, `main` at `4929cc6e`, the same engine
  build. Probes 1–11 and 14–18 were asked of it after the roll forward, and each answered as
  the column says — the policy equal, the 304 carrying it, the document equal to the built
  one — with the module's brotli transfer 2,139,182 bytes that time.
- **Version `e9947184-6ee1-4a07-ad79-841d93196210`, deployed at 13:43:02 UTC from `main` at
  `e1e76f78`** — what production served until 23:19. The same engine build, and a renamed
  `index` chunk, so `J` is another name. **All eighteen were asked of it and each answered as
  the column says**: the policy equal byte for byte on every response that carries it, the 304
  included; the document equal to the built one; the module 2,138,948 bytes as brotli; probe 12
  a `404`; probe 13 still `200` over plain `http` — five minutes before the setting behind it
  was turned on.
- **Version `befbcbd9-be3d-45f5-8150-4af8ff5337c9`, deployed at 23:19:22 UTC from `main` at
  `2bbd4446` — what production served until 02:29 UTC on 2026-10-05**, and the build the owner
  paired with a desktop that day. Engine build id `d6f5dc2a123a220e`, `index-B-KQBiDj.js`,
  `worker-WDxbzWW_.js`; by an agent under the phase's standing ask, with the wrangler this
  directory's lockfile pins (4.146.0, `npm ci --ignore-scripts --prefix infrastructure/app-worker`). The steps
  in order: `npm ci`; `web:wasm` (6 836 569 B); `web:build`; `web:smoke` passed in 19.0 s;
  `web:sync-smoke` passed in 37.9 s; `web:deploy-guard` exit 0 (59 on both sides, v0.40.0);
  `wrangler dev --local` on 127.0.0.1 with probes 1–11 and 14–19 each answering as the table
  says (the module's brotli transfer 2 016 151 B locally); `deploy --dry-run` (48 files read);
  the deploy (13 files uploaded, 30 already there). **Just before it, at 23:18:35 UTC**,
  production answered probe 1 with the old policy (no relay), probe 19 `0`, and probe 20 `204`
  with the allow-origin line — the answer that means *go*.

  **All twenty at 23:19:35 UTC, against the real address**: 1, 2, 4 — `200`, `text/html` (no
  charset), `no-cache`, `nosniff`, `strict-origin-when-cross-origin`, the policy equal byte for
  byte to `apps/light/dist-web/_headers`, one `ETag` for all three; 3 and 5 — `Not found 404 text/plain;
  charset=utf-8`; 6 — `200 text/html`; 7 — `200`, `application/wasm`, `public,
  max-age=31536000, immutable`, the policy equal; 8 — `content-encoding: br`, **2 169 729 bytes
  on the wire** (the module is 6 836 569); 9 — `200`, `text/javascript`, a year, immutable, the
  policy equal; 10 — `200`, `text/javascript`, `no-cache`, the policy equal; 11 — `404`; 12 —
  `404`; 13 — `301 Moved Permanently`; 14 and 15 — `404`, `text/plain; charset=utf-8`,
  `no-store`, `nosniff`, no policy line; 16 — `200`, `image/png`, `no-cache`, the policy equal;
  17 — `200`, `text/javascript`, `no-cache`, the policy equal, a strong `ETag`; 18 — `304 Not
  Modified` with the policy on it, equal; **19 — `1`, and the `wss://` source is there too**;
  **20 — `204`, `Access-Control-Allow-Origin: https://mtg-grimoire.app`,
  `access-control-allow-headers: authorization, content-type`, `access-control-allow-methods:
  POST`, `access-control-max-age: 86400`**. The document served — to a plain `GET /` and to a
  navigation of `/decks/12` — is byte for byte `apps/light/dist-web/index.html`.

  **One look in a real browser, at 23:21 UTC** — headless Chrome on a throwaway profile at
  1280×800, `https://mtg-grimoire.app/settings`, 17 s: no policy violation; no error of the
  app's (the one console error was Chrome's own new-tab page failing to resolve a Google host);
  the first run began (`api.scryfall.com`, `data.scryfall.io`); **no request to the relay and
  no socket**, from a device in no group; and the Sync panel, 4.6 s in: *Browser — not paired
  yet.*, *Pair a device*, *Enter a code from another device*, *Not connected.*, *Connect
  Patreon*, *Sync is off. Nothing leaves this device until you connect a membership.* — the
  refusal sentence is gone. Nothing was pressed that asks the relay. **Not seen: a browser
  pairing, or opening a socket, in production** — that needs the owner's membership. (**Since
  said, of this version, by the owner on 2026-10-05**: he paired it with a desktop and synced
  between them — "it works". His sentence, not a measurement.)
- **Version `685ae2ad-2309-4824-b707-6a39c159053e`, deployed on 2026-10-05 at 02:29:39 UTC
  from `main` at `117827d2` — what production serves.** It carries step 6.3b's engine and
  step 6.5b's, which pulls in pages, and beside them two other sessions' work that `main` held:
  #828's backup archive and #830's *Not sorted* controls. Engine build id `a3947b5c7a3ba658`
  (the module 6 862 338 B), `index-ByCbemTm.js`, `worker-DfcE0hqp.js`; by an agent under the
  phase's standing ask, eight minutes after the relay's own deploy (02:21:29 UTC — the relay
  that answers a page), with the wrangler this directory's lockfile pins. The steps in order:
  `npm ci`; `web:wasm`; `web:build`; `web:smoke` passed in 20.9 s; `web:sync-smoke` —
  ⚠️ **the first run failed in teardown**, `EBUSY … unlink
  …\grimoire-web-smoke-…\first_party_sets.db-journal`, a temp profile Chrome had not let go
  of, with the walk's own lines not printed; **the second run passed all twelve lines in
  63.3 s** (the harness has since stopped failing a run over a profile it cannot remove:
  `scripts/web-smoke/harness.mjs`'s `discard`); `web:deploy-guard` exit 0 (59 on both
  sides, v0.40.0); `wrangler dev --local` with probes 1–11 and 14–19 each answering as the
  table says (the module's brotli transfer 2 025 348 B locally); `deploy --dry-run` (48 files
  read); the deploy (12 files uploaded, 31 already there).

  **All twenty at 02:29:46 UTC, against the real address**, each as the previous deploy's
  bullet has it: the policy equal byte for byte to the built one on every response that
  carries it, the 304 included; both relay sources named (probe 19); the document equal to
  the built one; **the module 2 178 693 bytes as brotli** (it is 6 862 338); probe 20 `204`.

  **One look in a real browser, at 02:30 UTC** — a throwaway headless Chrome: no policy
  violation, no error of the app's, no request to the relay and no socket from a device in
  no group, and the Sync panel as before. Nothing was pressed that asks the relay. **Not seen
  since this deploy: anybody's sync** — a browser on this build pulling a page from the
  deployed relay, or a released desktop reading its streamed answer; the owner was asked.

```
A=https://mtg-grimoire.app
B=$(ls ../../apps/light/dist-web/wasm)                       # the engine's build id, from the build deployed
J=$(ls ../../apps/light/dist-web/assets | grep -m1 '^index-.*\.js$')
W=$(ls ../../apps/light/dist-web/assets | grep -m1 '^worker-.*\.js$')   # the engine's Worker
H='^HTTP|content-type|cache-control|content-security-policy|x-content-type|referrer-policy|content-encoding|^etag'
```

| # | Probe | Should answer | Answered |
| --- | --- | --- | --- |
| 1 | `curl -s -o /dev/null -D - "$A/" \| grep -iE "$H"` | `200`, `text/html`, `cache-control: no-cache`, `nosniff`, `strict-origin-when-cross-origin`, and the policy — **byte for byte the line in `_headers`** | **2026-10-04** — `200`, `text/html` with no charset, `no-cache`, `nosniff`, `strict-origin-when-cross-origin`, and the policy equal byte for byte |
| 2 | `curl -s -o /dev/null -D - -H "Sec-Fetch-Mode: navigate" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html`, **and the same policy line and `cache-control: no-cache`** — the fallback document, answered at the edge with the script not run. This is the document every deep link and every reload of one gets; a policy on `/` alone would not be a policy | **2026-10-04** — `200`, `text/html`, `no-cache`, the policy equal byte for byte, and probe 1's `ETag` |
| 3 | `curl -s -w " %{http_code} %{content_type}\n" "$A/decks/12"` | `Not found 404 text/plain; charset=utf-8` — curl accepts `*/*`, so the script refuses it | **2026-10-04** — `Not found 404 text/plain; charset=utf-8` |
| 4 | `curl -s -o /dev/null -D - -H "Accept: text/html" "$A/decks/12" \| grep -iE "$H"` | `200`, `text/html`, the policy and `no-cache` — the script, through the binding. The docs do not say `_headers` reaches this one; the asset worker's source does (`attachCustomHeaders` wraps every response, matched on the path the script asked — `/`) | **2026-10-04** — `200`, `text/html`, `no-cache`, the policy equal byte for byte, and probe 1's `ETag` again — so `_headers` does reach it |
| 5 | `curl -s -w " %{http_code} %{content_type}\n" "$A/assets/nope.js"` | `Not found 404 text/plain; charset=utf-8`. ⚠️ **`200 text/html` here means the script is not deployed** and every renamed chunk is being answered with the document | **2026-10-04** — `Not found 404 text/plain; charset=utf-8` |
| 6 | `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Sec-Fetch-Mode: navigate" "$A/assets/nope.js"` | `200 text/html` — Cloudflare's rule for a navigation, harmless | **2026-10-04** — `200 text/html` |
| 7 | `curl -s -o /dev/null -D - "$A/wasm/$B/grimoire_web_bg.wasm" \| grep -iE "$H"` | `200`, **`application/wasm`**, `public, max-age=31536000, immutable`, and the policy | **2026-10-04** — `200`, `application/wasm`, `public, max-age=31536000, immutable`, the policy equal byte for byte |
| 8 | the same with `-H "Accept-Encoding: br, gzip"` | a `content-encoding` — `application/wasm` is on Cloudflare's default list. **Record which**: it is the size a reader downloads | **2026-10-04** — **`content-encoding: br`, 2,139,023 bytes on the wire** for a module of 6,767,338; 2,373,483 when only gzip is offered. The `ETag` turns weak, `W/"…"`, on the compressed response; the caching and the policy are probe 7's. ⚠️ A browser that offers `zstd` is sent that instead — Chrome 154 downloaded 2,176,146 bytes the same day |
| 9 | `curl -s -o /dev/null -D - "$A/assets/$J" \| grep -iE "$H"` | `200`, a JavaScript MIME type (wrangler's table says `application/javascript`; the preview says `text/javascript`; a browser takes either), a year, immutable — and **not** `no-cache, public, …`, which is the detach not working | **2026-10-04** — `200`, `text/javascript` with no charset, `public, max-age=31536000, immutable` — one value — the policy equal byte for byte |
| 10 | `curl -s -o /dev/null -D - "$A/sw.js" \| grep -iE "$H"` | `200`, a JavaScript MIME type, **`cache-control: no-cache`** — one value — and the policy: the service worker's own `fetch` of a card picture is held to the line on *this* response. ⚠️ `404` means the build deployed has no service worker (`web:build` writes `sw.js` last) | **2026-10-04** — `200`, `text/javascript`, `no-cache` — one value — the policy equal byte for byte |
| 11 | `curl -s -o /dev/null -w "%{http_code}\n" "$A/_headers"` | `404` — the file is parsed, not served, which is why a service worker's precache list must leave it out | **2026-10-04** — `404` |
| 12 | `curl -s -o /dev/null -w "%{http_code}\n" https://mtg-grimoire-app.denmark-east.workers.dev/` | **not `200`** — there is no second origin | **2026-10-04** — `404` |
| 13 | `curl -sI http://mtg-grimoire.app/ \| head -3` | a redirect to `https`, if the zone has *Always Use HTTPS* on. A browser never asks: `.app` is HSTS-preloaded | **2026-10-04** — ⚠️ **`HTTP/1.1 200 OK`, `text/html`, and no redirect.** *Always Use HTTPS* was off on the zone, so a `curl http://` was handed the document in the clear — at 12:48 UTC, and again at 13:43. **Since about 13:48 UTC the same day: `301`, `Location: https://mtg-grimoire.app/`** — the owner asked for the setting to be on; a path and its query are kept (`/decks/12?x=1` to the same on `https`) |
| 14 | `curl -s -o /dev/null -D - -H "Sec-Fetch-Mode: no-cors" -H "Accept: image/avif,image/webp,image/*,*/*;q=0.8" "$A/mtgimg/display/abc/0" \| grep -iE "$H"` | `404`, `text/plain`, **`cache-control: no-store`** — an `<img>`'s request, as a page no service worker controls makes it. ⚠️ `200 text/html` is the document where a picture was asked | **2026-10-04** — `404`, `text/plain; charset=utf-8`, `no-store`, `nosniff`, and no policy line: the script's own three headers, which `_headers` does not reach |
| 15 | the same with `-H "Accept: text/html"` and no `Sec-Fetch-Mode` | `404` again — the script holds no place under `/mtgimg/` | **2026-10-04** — `404`, `text/plain; charset=utf-8`, `no-store`, as probe 14's |
| 16 | `curl -s -o /dev/null -D - "$A/icons/icon-192.png" \| grep -iE "$H"` | `200`, `image/png`, `cache-control: no-cache` | **2026-10-04** — `200`, `image/png`, `no-cache`, the policy equal byte for byte |
| 17 | `curl -s -o /dev/null -D - "$A/assets/$W" \| grep -iE "$H"` | `200`, a JavaScript MIME type, **`cache-control: no-cache`** — one value, not a year and not three joined — the policy, and an `etag` | **2026-10-04** — `200`, `text/javascript`, `no-cache` — one value — the policy equal byte for byte, and a strong `ETag` |
| 18 | `E=$(curl -s -o /dev/null -D - "$A/assets/$W" \| grep -i '^etag' \| cut -d' ' -f2 \| tr -d '\r')`, then `curl -s -o /dev/null -D - -H "If-None-Match: $E" "$A/assets/$W" \| grep -iE "$H"` | **`304`, with the policy line on it.** This is the response that re-governs a returning reader's engine after a change to `_headers`; a 304 without the policy leaves the old one in force (measured) | **2026-10-04** — **`304 Not Modified`, with the policy on it, equal byte for byte**, `no-cache`, and probe 17's `ETag` |
| 19 | `curl -s -o /dev/null -D - "$A/" \| grep -i '^content-security-policy' \| grep -c 'connect-src[^;]* https://mtg-grimoire-relay\.denmark-east\.workers\.dev[ ;]'` | `1` — the policy the host sends names the relay. `0` is a build from before the engine asked it from a page, and that build's sync panel answers the refusal sentence instead | **2026-10-04, 15:59 UTC** — `0`: production was a build from before this entry (and `0` again at 23:18:35, a minute before the deploy). **Asked again at 23:19:35 UTC, of the build deployed at 23:19:22 — `1`**, and the `wss://` source is in the same line |
| 20 | `curl -s -o /dev/null -D - -X OPTIONS -H "Origin: $A" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization,content-type" https://mtg-grimoire-relay.denmark-east.workers.dev/token \| grep -iE '^HTTP\|^access-control'` | `204`, **`access-control-allow-origin: https://mtg-grimoire.app`**, and an `access-control-allow-headers` that names `authorization` and `content-type` — the two request headers the engine sets, and the pre-flight every sync request from a page costs. ⚠️ **Asked of the relay, not of this Worker, and asked BEFORE this Worker's deploy** (*The steps, in order*): no allow-origin line is a relay that cannot answer a page | **2026-10-04, 15:59 UTC** — `405 Method Not Allowed`, `Allow: POST`, **and no `access-control-*` line**: the relay deployed that minute predates its allow-list, which is the answer that means *stop*. **Asked again 2026-10-04, 23:09 UTC**, of the relay deployed at 17:22 — **`204` with `access-control-allow-origin: https://mtg-grimoire.app`** and `access-control-allow-headers: authorization, content-type`: the answer that means *go* |

**Beside the table, the same minute**: the document served — to `-H "Sec-Fetch-Mode: navigate"`
and to a plain `GET /` — was byte for byte `apps/light/dist-web/index.html`; and `www.mtg-grimoire.app` did
not resolve, so there is no third name to be a second origin. **Two things the table's *should*
column did not foresee, neither a fault**: the edge sends `text/html` and `text/javascript` with
no `charset` (the document declares its own in a `<meta>`), where `wrangler dev` adds
`; charset=utf-8`; and plain `http` is answered, not redirected — probe 13. **Both halves of
that are history since about 13:48 UTC**: plain `http` is a `301`, and `www` resolves and is a
`301` to the apex — *What the zone was asked to do since*, below.

Then open the address in a browser with its console open: no policy violation, the app past its
gate, and `database open in OPFS` on the console. That is the probe no `curl` can make. ⚠️ **Look
at the document's source while there**: a `<script>` the build did not write is a zone feature
rewriting the page — *Before the first deploy*, below. **Made on 2026-10-04 at 12:50 UTC**, in
headless Chrome 154.0.8037.95: no violation, the app past its gate, that console line, and one
`<script>` in the source and in the live DOM — *What the browser said under it* has the run.

⚠️ **"Byte for byte the line in `_headers`" means the `_headers` of the build that was
deployed** — `apps/light/dist-web/_headers`, never this directory's on another commit. **The host has the
relay's sources since the deploy of 23:19 UTC on 2026-10-04**: this directory's policy names
`https://mtg-grimoire-relay.denmark-east.workers.dev` and its `wss://` twin in `connect-src`,
and so does production's. (Until that deploy the tree was ahead of the host by those sources,
and this paragraph said so.) The dated *Answered* cells of probes 1–18 are from builds without
them and stay true of those builds; the bullets above have all twenty as the build of 23:19
answered and as the present one does. Probes 19 and 20 came with the relay's sources. Each was asked first at 15:59 UTC of
hosts that should *not* pass yet, and neither did — so both can fail — **and each has now been
asked of a host that should pass, and did**: 20 of the relay at 23:09 and 23:18, 19 of this
Worker at 23:19:35.

**On a day the account's free limit is spent, probes 3–5, 11, 14 and 15 answer `429 text/html`**
— Cloudflare's own page, not the script's 404 — and the rest are unchanged. *Cost* has why.

### The steps, in order

⚠️ **The relay's deploy comes first, whenever the two have to agree.** The web app asks the
relay from a page, and the relay answers a page only for an origin on its allow-list. Deployed
in the other order — a web build that asks, in front of a relay that does not answer — **every
sync request fails, loudly**: the pre-flight is refused, the engine reports `error sending
request`, and the console fills. How fast it fills was measured once, by the mistake next
door: on the first run of the hosted app (2026-10-04) one press of *Pair a device* made
thirteen requests in fifteen seconds, each refused — by the policy that day, which did not
name the relay. The other order costs nothing: a relay that answers an origin nobody asks
from yet is a header on no request. So:

- **Before step 7, ask the relay** — probe 20 above. No `access-control-allow-origin` on its
  answer means the relay that is deployed predates its allow-list: stop, and deploy the relay
  (`docs/reference/hosted-relay-deploy.md`) before this.
- **A changed `_headers` is a new build to every reader.** The service worker hashes the file
  into its build id, so the deploy that adds a host to `connect-src` offers the update bar to
  everybody who has been before, and the engine's Worker chunk is revalidated into the new
  policy (*The policy*, above). What that update costs a reader was measured for a
  `_headers`-only deploy — *What a deploy changes for a reader*: 43 small requests, the engine
  not downloaded again. **Step 6.3's is one of these twice over**: it adds the relay's `wss://`
  source to `_headers` *and* ships a new engine (the browser's socket, and the loop that opens
  it), so its deploy is a new worker build, a new module to download, and an update bar for
  every reader who has been before. Until it is deployed the live site's engine opens no
  socket, so the old policy refuses nothing; a deploy of the page without the header — or the
  header's revalidation failing — would be a paired tab reading *Not connected to the relay*
  with the violation in its console, and push, pull and ack, which are requests, still working.

1. **`npm ci`**, on Node from `.nvmrc`.
2. **`npm run web:wasm`** — the engine, into `dist-wasm/`. It needs the `wasm32-unknown-unknown`
   target, **clang 18 or newer** (the SQLite shim is C23; on Windows the script looks in the LLVM
   installer's folder), and a **`wasm-bindgen` CLI of exactly the version `Cargo.lock` resolves**
   — `cargo install wasm-bindgen-cli --version <that> --locked`. The script checks all three and
   says which is wrong.
3. **`npm run scanner:assets -- --web`, then `npm run web:build`** — the card scanner's three
   files into `dist-wasm/scanner-assets/` with their manifest (18 MB from this repository's
   public release), then the page, into `apps/light/dist-web/`, with the engine under `wasm/<build id>/`,
   the scanner's module under `wasm/<its own build id>/scanner/`, the three files and
   `manifest.json` under `scanner-assets/`, and `_headers` at its root. Without the first
   command the build still builds and says the scanner's files are not in it; with
   `GRIMOIRE_SCANNER_ASSETS=required` — as CI and the release set it — it fails instead. ⚠️ **`wrangler deploy` uploads whatever is in `apps/light/dist-web/`**: the
   last build on this machine, not this commit. Build from the commit being deployed, with a clean
   tree, and check `apps/light/dist-web/_headers` is there — a `apps/light/dist-web/` built before step 5.5 has none,
   and deploys as an app with no policy and no caching rules.
4. **`npm run web:smoke`** and **`npm run web:scanner-smoke`** (a file for a camera, one real
   card, from the offer's Download to the collection and then offline), then
   **`npm run web:preview`** and a look in a real browser. Against a deployed or `wrangler dev`
   host, the scanner's addresses to probe are: `/scanner-assets/manifest.json` and the three
   files (`200`, `Cache-Control: no-cache`, the manifest `application/json`),
   `/wasm/<id>/scanner/grimoire_scan_bg.wasm` (`application/wasm`, a year and immutable) and
   `/assets/scanWorker-<hash>.js` (`no-cache`, carrying the policy — a Worker runs under its
   own script's). After a deploy, `scripts/web-deploy-probe.mjs` asks the first of these itself: the
   manifest the address serves must be the bundle's, byte for byte, and for the bundle format
   this tree's scanner reads — a web app deployed without its scanner's files is red there. The
   preview applies the policy by this repository's own reading of `_headers`. **And
   `npm run web:sync-smoke`** when the engine's sync, the relay or `connect-src` changed: two
   headless Chrome profiles — the desktop face and the phone face — claim, pair and sync
   through `infrastructure/relay/`'s own code under workerd, by the relay's real name and under this policy,
   so a `connect-src` that lost either of the relay's sources fails there before a reader meets
   it. It runs this directory's own pinned wrangler (the install under *Step 0*; or
   `WRANGLER=<path to a wrangler.js>`), and of wrangler only `d1 execute --local` and
   `dev --local`: it reaches no Cloudflare.
5. **`cd infrastructure/app-worker && npx --no-install wrangler dev`, and the probes against it — before anything is
   public.** `wrangler dev` runs Cloudflare's own asset worker and router worker locally, the
   code `workers-sdk` publishes and the edge runs, over this `wrangler.jsonc` and this
   `apps/light/dist-web/`, and deploys nothing. Set `A=http://localhost:8787` (wrangler's default port) and
   run the table: it answers **the navigation split (2, 3, 5, 6, 14, 15), the headers on the
   fallback document and on the one the script fetches (2, 4), the detach and the one-value
   `Cache-Control` (7, 9, 17), the 304 that carries the policy (18), `/_headers` (11), `/sw.js`
   (10) and the content types (7, 9, 16)** — every question about how *Cloudflare's code* reads
   this configuration, which `web:preview` can only answer in this repository's own words.
   ⚠️ **This step matters more here than for the other two Workers**: with both alternate
   origins off there is no `workers.dev` address to look at first, so the first deploy is live
   on the apex the moment it finishes. **Run once, on 2026-10-04, as `wrangler dev --local`**
   (wrangler 4.146.0, port 8787), over the build deployed later that day: probes 1–11 and 14–18
   each answered as the table says it should, and the document served equalled the built one.
   Probes 12 and 13 have nothing local to ask. **What differed from the edge, none of it a
   fault**: text types carried `; charset=utf-8`, every `ETag` was another value for the same
   bytes, the compressed module kept a strong one, and its brotli transfer was 1,986,553 bytes
   against the edge's 2,139,023 — so the local figure is not the size a reader downloads.
   `--local` reaches nothing, which is what the rule above turns on; if it asks to log in, it is
   not in local mode: stop.
6. **`npm run web:deploy-guard`, from the repository root — and stop if it does not exit 0.**
   It reads `USER_SCHEMA_VERSION` in this tree and at the last release's tag and says which it
   found in one sentence. **Exit 1 is the answer that means *wait for a release*:** *"This
   tree's user schema is 60, the last release (v0.40.0) is 59: a web app deployed from here
   would send paired desktops ops they must hold until a release exists."* The remedy is to
   release — merging the release PR deploys this Worker from the tag — or to deploy from the
   tag's checkout instead of `main`'s. **It also asks GitHub whether that release is
   published** (`gh release view`): the tag is made with the *draft*, so after a release run
   that failed, this tree can equal a release nobody can install — exit 1, *"… is still a
   draft"*. Exit 2 is *could not tell* — the tag is not fetched (`git fetch --tags`), or `gh`
   is missing or could not ask — and is not a pass; `--offline` skips the question and says so.
   It needs no build, so it can be run first; it is here because here is the last moment it
   can stop a deploy. **Run on 2026-10-04**: 59 on both sides, v0.40.0 published — `main` had
   not moved the schema since.
   ⚠️ **What it cannot see: equal schemas are necessary, not sufficient.** A change to the
   wire that is not a schema rung — a new op `kind`, say — reaches a desktop on the last
   release as a batch it cannot parse and that says nothing newer of itself: `Malformed`,
   which the client **steps over**, where it would hold a `Newer` one. Dropped, not held, and
   no update brings it back. The guard reads one constant and passes that tree. **If `main`
   has changed what an op looks like since the last release, wait for the release whatever
   this step says.**
   (The first deploy's own step here was *look at the zone* — *Before the first deploy*, below
   — which is done.)
7. **`npx --no-install wrangler deploy`**, from `infrastructure/app-worker/` — `--dry-run` first, which uploads nothing. Read
   what it prints: the files it read and uploaded, the binding, the custom domain it attached and
   the version id. ⚠️ **It does not say how many `_headers` rules it parsed.** This step told its
   reader to read that count until 2026-10-04, when wrangler 4.146.0 printed no such line.
   **The proof the rules were taken is step 8's probes 1, 7, 9, 10 and 17 answering with the
   `Cache-Control` each should** — the default, the two trees and the two files. The first
   deploy created the DNS record and the certificate for `mtg-grimoire.app`: the zone held no
   DNS record at all that day, so nothing was in the apex's way, and **the apex answered 200
   with the document on the first request after the command returned** — no wait for the
   certificate was observed, which is one deploy's experience and not a figure. ⚠️ A Custom
   Domain cannot be created over a hostname that already has a CNAME record; if the domain is
   ever detached and attached again, a record on the apex has to go first.
8. **Step 0's probes, all of them, against the real address**, and the answers written into the
   table above with the date.

⚠️ **Never `wrangler preview` for this Worker.** A Preview is the same bundle deployed at
another address, and any second origin is a second, empty OPFS that looks like the app.
Cloudflare's Previews pages say a Preview's `workers.dev` address is governed by `preview_urls`,
which is `false` here; the review of this directory read it as *not* governed. Nobody has run it,
and a reader's collection is not the thing to find out with.

### Before the first deploy: what the zone may do to the page

The policy is `script-src 'self'`, and a Cloudflare zone has features that **rewrite proxied
HTML** to add a script of their own. Each would be refused by the policy on every load — a
console error a reader never sees and a feature that silently does nothing — or, worse, would be
"fixed" by loosening the policy. **The zone was read through Cloudflare's API on 2026-10-04,
before the first deploy** — read-only, by the agent that then deployed — and the last column is
what it said. (This sentence read *nobody writing this has seen the zone* until then.) **A
setting is the owner's to change on any day, so the column is that day's and no later one's**;
these are the ones the documentation names, each to be confirmed **off** for `mtg-grimoire.app`:

| Feature | What it does to the page | Where the docs put it | Read 2026-10-04 |
| --- | --- | --- | --- |
| **Web Analytics, automatic setup** | injects `<script src="https://static.cloudflareinsights.com/beacon.min.js">` into every proxied page of the zone | `web-analytics/` — the dashboard's Web Analytics section, *Manage Site* for the hostname. ⚠️ Its *exclude EU visitors* option means an owner in Denmark may never be served the script that every reader outside the EU is — check the setting, not the page | **no Web Analytics site on the account** |
| **Rocket Loader** | rewrites `<script>` tags and adds its own loader | `speed/optimization/content/rocket-loader/` — "If you have a Content Security Policy … you will need to update your headers" | **off** |
| **Email Address Obfuscation** | rewrites e-mail addresses it finds in the HTML — idle while the document has none, which is today | named beside Rocket Loader on that page as using non-standard tags | ⚠️ **on** — the zone's default, and idle: the built document contains no `@`. Left as found; it is the owner's setting |
| **JavaScript Detections** (bot settings) | injects an **inline** script; the docs quote the console error `script-src 'self'` produces. It also strips the `ETag` from HTML it touches | `cloudflare-challenges/challenge-types/javascript-detections/` | **off** (`enable_js`), and bot fight mode off |

None of them is turned on by anything in this repository; each is a setting of the zone. **The check that cannot be fooled** is the document a reader gets: `curl -s
-H "Sec-Fetch-Mode: navigate" https://mtg-grimoire.app/ | diff - ../../apps/light/dist-web/index.html` — from
outside the EU as well, if Web Analytics was ever on — must print nothing. **It printed nothing
on 2026-10-04**, for the navigation and for a plain `GET /` alike — asked from Denmark and from
nowhere else.

**The one of the four that is on is the one to watch.** Email Address Obfuscation does nothing
to a document with no address in it, and nothing in this repository keeps one out: the day the
light entry's HTML carries an `@`, the served document stops equalling the built one, and that
`diff` is the only thing that would say so.

**What else the zone said that day**: active, on the Free plan, with **no DNS record at all**
before the deploy; SSL mode `full`; brotli on; **Always Use HTTPS off**, which is probe 13's
first answer; no HSTS header configured at the zone, `.app` being HSTS-preloaded as a TLD; and
the account's Workers were `mtg-grimoire-relay` and `mtg-grimoire-share`, neither with a custom
domain. Nothing was changed by that read.

**What the zone was asked to do since — two changes, at about 13:48 UTC the same day.** The
owner asked for both in chat — *"always use https should be **on** and we should add a redirect
from www. to the plain domain"* — and an agent made them through Cloudflare's API. They are
settings of the zone; nothing in this repository holds either, and no deploy of this Worker
touches them.

- **Always Use HTTPS is on.** `curl -sI http://mtg-grimoire.app/` is a `301` to
  `https://mtg-grimoire.app/`, and `http://mtg-grimoire.app/decks/12?x=1` a `301` to the same
  path and query on `https`. A browser never asked — `.app` is preloaded — so what changed is
  what a `curl`, a crawler or a link preview is handed.
- **`www.mtg-grimoire.app` redirects to the apex**, in the shape *What a deploy changes for a
  reader* prescribes: a rule on the zone, and no second Custom Domain on this Worker. It is two
  things.
  - **A DNS record that points nowhere**: `AAAA www → 100::`, proxied, with a comment saying
    it exists only so the rule runs. No origin is behind it and no Worker is attached to it.
  - **One Single Redirect rule**, in the zone's `http_request_dynamic_redirect` ruleset, which
    had none: when `http.host eq "www.mtg-grimoire.app"`, a `301` to
    `concat("https://mtg-grimoire.app", http.request.uri.path)`, the query string preserved.
  - The zone's certificates already covered `*.mtg-grimoire.app` — an advanced and a universal
    pack, both active — so none was issued for it.
- **Probed after**, through Cloudflare's resolver — the local one held a cached *no such name*
  from the 12:48 probe for a little while:

  | Asked | Answered |
  | --- | --- |
  | `https://www.mtg-grimoire.app/` | `301` to `https://mtg-grimoire.app/` |
  | `https://www.mtg-grimoire.app/decks/12?x=1` | `301` to `https://mtg-grimoire.app/decks/12?x=1` |
  | `http://www.mtg-grimoire.app/search` | `301` straight to `https://mtg-grimoire.app/search` — one hop, not two |
  | `http://www.mtg-grimoire.app/decks/12`, followed as a navigation | `200` at `https://mtg-grimoire.app/decks/12`, after one redirect |

  The apex document was still byte for byte the built one, and the policy still equal on every
  response that carries it.
- **`www` is not an origin of the app.** A browser that follows the redirect lands on the apex,
  so there is still exactly one OPFS, one service worker and one install. ⚠️ **That holds only
  while the name is a redirect**: attach it to this Worker, or point the record at anything
  that answers 200, and it is the second, empty origin this file warns of.
- **So the zone now has two DNS records** — the apex's, which the deploy made, and `www`'s.
- **Email Address Obfuscation is still on**, and still the owner's. Neither change touched it.

### What a deploy changes for a reader

- **Every deploy renames the chunks that changed.** A page already open keeps running on what it
  loaded, and its next lazy import of a renamed chunk is a 404 — which the app has to recover
  from. Step 5.3's service worker takes that case away rather than recovering from it: a page it
  controls is served its own build, whole, out of a cache named for that build for as long as the
  page is open, and a bar offers the new version, which only the reader's press activates
  (light-app.md §9.3). A page no worker controls — a browser with none, or one that evicted the
  cache under a live page — can still meet a face that fails to load across a deploy, and a
  reload cures it.
- **The engine keeps its address across a deploy that did not change it.** Its directory is a
  hash of its own bytes, so a deploy of the page alone does not make anybody download the module
  again.
- **A deploy that changes only `_headers` renames nothing, and still reaches a reader who has
  been before** — through the two responses a policy is read from, both `no-cache`: the document,
  and the engine's Worker chunk, whose 304 carries the new line. From 5.3 on it must also get
  past the service worker, which that step arranges by hashing `_headers` into its build id.
- **Measured on 2026-10-04, three times, at the real origin**: exactly that deploy — two comment
  lines in `_headers`, so `_headers` and `sw.js` were the only files that differed — under one
  open tab in headless Chrome 154 with a reader's data in it.
  - **The bar was drawn 648–689 ms after the check**, with the new worker `installed` and
    waiting and both builds' shell caches held. A reload while it waited stayed on the old
    build, with the bar back; *Not now* put the bar away and the next load brought it back.
  - **The install downloaded nothing again**: 43 requests of about 810–845 bytes each, 35 KB in
    all, the engine's module 843 bytes of it — and no request to any other host.
  - **The press** gave a new document about 2.6 s later, with one shell cache — the new
    build's — the reader's deck, collection and wishlist intact, and the corpus as it was.
  - ⚠️ **The check was the driver's `registration.update()`, never the app's own.** Headless
    Chrome would not fire `visibilitychange`, and the app asks at most hourly. That a reader is
    offered a build without anybody calling for it is unseen here. (Seen once since, and not
    in Chrome — the last sub-bullet of the next item.)
  - ⚠️ **No chunk was renamed**, so the first bullet above — a page meeting a renamed chunk
    across a deploy — is still unseen at the real host. (Seen since — next.)
- **Measured on 2026-10-04 at 13:43 UTC: the first deploy that renamed chunks**, seven of them,
  with the engine and its Worker chunk unchanged — under two headless Chrome 154 browsers held
  open on the build before it. **The first bullet of this list, in both its halves.**
  - **A page the service worker controls never met the rename.** The host answered every one
    of the old names `404`; the page then opened the desktop face, the deck editor and the note
    editor, none of which it had loaded — and each old chunk came from the worker's own shell
    cache, with nothing on the wire.
  - **The update, when taken, cost the chunks that changed and nothing of the engine**: the
    install was 43 requests and 839,607 bytes, of which the engine's module was 843. The bar
    came 659 ms after the check; a reload stayed on the old build; the press gave a new
    document 2.7 s later on the new build's cache alone, with the reader's data intact.
  - **A page the worker does not serve got a 404 and a sentence — not HTML.** Staged by
    bypassing the worker for one page: its two lazy chunks were each `404`, `text/plain;
    charset=utf-8`, `no-store` — the script in this directory doing its one job — and the
    reader saw the app's mark, *This page could not be drawn.* and a *Reload* link, which drew
    the new build in 2.1 s with the data intact. ⚠️ A bypass is not a browser with no worker:
    `navigator.serviceWorker.controller` was still set, and a page with a null controller
    could not be held to test.
  - ⚠️ **The app's own check was held by its hourly limit, not by the event.**
    `visibilitychange` was made to fire three ways on a document 226 s old and the app did not
    ask; the check was again the driver's. **The one sighting of the app asking by itself is
    the owner's, in Firefox** — *"i got a little toast notifying me a new version is
    available"*, at about 13:42 UTC. By the timing, and by nothing his tab reported, the build
    it offered was the 13:27 one.
- **The origin is the app's identity and must never move.** A browser keys both OPFS databases,
  the service worker and the install to it. Served from another host, another subdomain or `www`,
  a reader's collection is not there — it is still in their browser, under the address they can no
  longer reach. For the same reason `www.mtg-grimoire.app`, if it is ever wanted, is a **redirect
  rule on the zone** to the apex and never a second Custom Domain on this Worker. **It was
  wanted, and that is what it is** — since 2026-10-04, a `301` to the apex with the path and
  query kept (*Before the first deploy*, above, has the rule and the record behind it).
- **The relay knows this origin by its exact string.** Its CORS allow-list names
  `https://mtg-grimoire.app` (`APP_ORIGINS`, `infrastructure/relay/wrangler.jsonc`) and `_headers` names the
  relay, so an origin that moved would also be one the relay refuses on every request — sync
  would stop for the readers the move had already cost their collections.

### Rolling back

`npx --no-install wrangler rollback` from this directory makes the previous version the
deployment; `npx --no-install wrangler versions list` shows what there is to go back to (the
100 most recent). **To a reader a
rollback is another deploy**: the chunk names change again, and a page opened on the bad build
meets the same 404 on its next lazy import.

**Run once, on 2026-10-04, and then run again to go forward.** The owner approved a rollback
test; this section said *none of this has been run* until then. Two builds that differ in
`_headers` and `sw.js` alone — the first deploy, and a marker deployed at 13:27 UTC.

| UTC | Command | What the host's `sw.js` then was |
| --- | --- | --- |
| 13:28:58 | `wrangler rollback <the first version's id> -m … -y` | the marker's at the first look, **the first deploy's five seconds later** |
| 13:30:22 | `wrangler rollback <the marker's id>` | the first deploy's at the first two looks, 5 s apart; the marker's at the third |

- **A rollback does bring a version's files back with it**, within seconds.
- **`rollback` takes any version id**, so it rolls forward too — which is how production came
  back to the marker without a third upload. (A later deploy that day replaced it.)
- **Non-interactive, `-y` prints *Using fallback value in non-interactive context: yes***, and
  the command warns that it *will not rollback any of the bound resources*. This Worker binds
  nothing but its assets, which are the version's.
- `npx wrangler deployments list` shows the three deployments with their messages.
- **To the page that was open it was an update like any other**: the first deploy's `sw.js` is
  different bytes from the marker's, so the bar offered it, and until the press the page went
  on working on the build it had — *What a deploy changes for a reader*, above.

⚠️ **What that run was not**: a rollback of a build that renamed chunks, or of one that shipped a
schema rung. Neither build changed the page's code or the database. **The build production now
serves did rename chunks, so rolling it back would be the first of that kind** — to a page in
the worker's control it should be one more update offered, as the forward direction was.

**It does not roll back a reader's data.** If a build migrated a schema in OPFS, the build before
it is now looking at a database from its future. A page-only fault is safe to roll back; a build
that shipped a schema rung is fixed forwards.

### What is settled, what `wrangler dev` settles, and what only a deploy can

**Every probe in the table has been run — on 2026-10-04, locally where it can be asked and then
at the real address.** This section opened *nothing in the probe table has been run, anywhere*
until that day. The questions are still not all the same kind, and most of them do not need a
public address — which is what step 5 is for on every deploy after the first.

**Read off Cloudflare's own source** (`cloudflare/workers-sdk`, `packages/workers-shared`, at
`f025bbfd`, 2026-10-03) — the asset worker and the router worker that `wrangler dev` runs
locally and Cloudflare runs in front of a Worker with assets. Read first, and **since
2026-10-04 run**, by the probes named at each:

- **`_headers` reaches the fallback document and a document the script fetched through the
  binding.** `handleRequest` (asset-worker) wraps *every* response it returns in
  `attachCustomHeaders`, matched on the path of the request it was given — the 200, the
  single-page fallback, the 304. (Probes 2, 4 and 18.)
- **The navigation split.** `canFetch` keeps `not_found_handling` only when the request carries
  `Sec-Fetch-Mode: navigate` (and the flag is on); for every other request a miss is "no asset",
  and the router sends it to the script. (Probes 2, 3, 5, 6, 14 and 15.)
- **Detach, then set, yields one value** (probes 7, 9, 10 and 17); rules apply in the file's
  order; two rules for one path are one rule, the last (`constructHeaders` stores them by path);
  a rule with nothing under it is dropped. **Those last two are still read and not run** —
  `src/headers.ts` refuses a file that would show either, so no build can carry one to a host.

**Step 5, `wrangler dev`, turned each of those from read to run** — the navigation split, the
headers on both documents, the detach, the Worker chunk's 304, `/_headers`, the content types —
with nothing public, and the edge then answered the same.

**Only a deploy could settle these, and the ones on 2026-10-04 settled each but the preview
address**:

- **The certificate and the apex**: ~~how long issuance takes, and whether a record was in the
  way~~ — no record was (the zone had none), and the apex answered 200 on the first request
  after the deploy returned. No wait was observed; no duration was measured.
- **What the edge compresses the module with** (probe 8), and so what a first visit downloads:
  **brotli, 2,139,023 bytes on the wire** for the 6,767,338-byte module, and 2,373,483 where
  only gzip is offered. ⚠️ **That is `curl`'s answer and not a reader's**: Chrome 154 offers
  `zstd`, the edge chose it, and the module was **2,176,146 bytes** on the wire there — the
  figure for a first visit in that browser. (This line carried an earlier module's figures
  until the deploy — 8,623,589 bytes, and 3.07 MB gzipped by Vite's report.)
- **That neither alternate origin answers**: the `workers.dev` name is a `404` (probe 12), and
  `www` did not resolve — and since about 13:48 UTC that day is a `301` to the apex, which is
  not an origin either. ⚠️ **A per-version preview address was not asked** — the table has no
  probe for one, so `preview_urls: false` is still the configuration's word and not the host's.
- **What the zone does to plain `http`** (probe 13): ~~it answers it — `200`, the document, no
  redirect — because *Always Use HTTPS* is off~~ — true at 12:48 and at 13:43 UTC. The owner
  asked for the setting on, and since about 13:48 it is a `301` to `https`, path and query kept.
- **What the zone's own features do to the document** — the table above: nothing, for the
  document asked from one country on one day.
- **That a rollback brings a version's files back with it.** ~~The limits are stated per Worker
  version, which says so; nobody has watched it.~~ **It does** — the host served the earlier
  version's `sw.js` five seconds after the command, on 2026-10-04 (*Rolling back*, above).
- **The policy against the real hosts, from this origin** — which `curl` cannot ask, and a
  browser did the same day (*What the browser said under it*, above): **every host in
  `connect-src` was asked from a page at `mtg-grimoire.app` and answered 200, the app asked no
  other host, and nothing was refused.** One run, in one Chrome.

**Open again, and only a deploy of both Workers settles it**: the relay asked from a page at
this origin. The policy names it and the engine asks it, in no build that has been deployed;
the relay's allow-list has answered no browser. Until a pairing has been driven at
`mtg-grimoire.app` against the deployed relay, "every host in `connect-src` was asked and
answered 200" is a sentence about five hosts and not six.

**And no deploy by itself settles these**, which are a browser's and a later day's: any
browser's *figures* but one Chrome's on Windows — the policy and the engine have met no Safari,
and of Firefox and of a phone there is the owner's one sentence each that it works, and nothing
measured; and a spent free-plan day. (This paragraph ended on a card picture through the service
worker as the one thing `img-src` had yet to draw. It has drawn them — on `localhost` in
light-app.md §9.6, and at the real origin on 2026-10-04.)

**A deploy over a page that is open with its service worker in control was on that list, and
has been seen** — four times that day, *What a deploy changes for a reader*. Its two halves
that stayed open after the first three, as they stand:

- ~~**A renamed chunk.** No build deployed so far differs from another in the page's code.~~
  **Answered at 13:43 UTC**: a controlled page is served its old chunks from the worker's
  cache, and a page the worker does not serve is answered a `404 text/plain` and offers a
  *Reload*.
- **The app's own check: seen once, in the owner's Firefox, and in no browser that was
  measured.** In Chrome the hourly limit held it every time, and no session kept a page open
  for an hour.

**And three things that deploy left**: a page with no controller at all — a browser with no
service worker, or an evicted cache under a live page — which a bypass only resembles; a
rollback of a build that renamed chunks; and the note editor's two violations, which the
component has since fixed and the next deploy is the first to carry (*What the browser said
under it*).

## Cost

Read from Cloudflare's documentation on 2026-10-04; none of it measured here.

- **A request for a file is free and unlimited, on the free plan too** — "Requests to static
  assets are free and unlimited" (`workers/platform/pricing`,
  `workers/static-assets/billing-and-limitations`). That is every chunk, every icon, both halves
  of the engine, and — with the script and the compatibility date this configuration has — the
  document for every navigation.
- **A request the script answers is a Worker request**, from the account's **100,000 a day** on
  the free plan (`workers/platform/limits`). ⚠️ **That is the same budget the relay's sync
  spends**, the cliff `infrastructure/relay/README.md` describes: past it every reader's sync errors at once.
  What reaches the script is a miss that is not a browser's navigation — a renamed chunk asked for
  by a page that predates a deploy, a crawler. In ordinary use that is a
  handful per reader per deploy. ⚠️ **And, from 5.3 on, every card picture a page asks before its
  service worker controls it**: each `/mtgimg/…` that reaches the network is one Worker request
  for a 404. A first visit that draws a wall of cards ahead of the worker taking control spends
  one per tile, so how soon that worker claims its page is a cost on this budget, not only a
  matter of broken pictures. Nobody has counted it. (**One first visit has been since**, at the
  real origin on 2026-10-04: none of the page's requests to this origin was a 404. The worker
  was in control at 1,553 ms, and a fresh profile has no card to draw until its corpus is built,
  21.4 s in. One run, in one Chrome; a returning reader whose worker was evicted is the case it
  does not cover.)
- **A flood of misses is the exposure**, and unlike the two `workers.dev` Workers this one sits
  behind a zone: a rate-limiting rule on `mtg-grimoire.app` can refuse a caller *before* the Worker
  is invoked, which `infrastructure/relay/src/ratelimit.ts` could not do for the relay. **None is configured.**
  It is the first thing to add if the relay's 70% notification ever fires for this Worker's sake.
- **What a spent day does, and does not do.** In the router's source
  (`router-worker/src/worker.ts`, `routeToUserWorker`), once the free limit is exhausted —
  `eyeballConfig.limitedAssetsOnly` — **every** dispatch to the script is answered instead with
  `429`, `Content-Type: text/html`, Cloudflare's own page. The path taken when no asset matched
  goes through that function exactly as a `run_worker_first` one does; the billing page's
  sentence about `run_worker_first` ("these requests will receive a 429 … instead of falling
  back to static asset serving") is true of it and is not a contrast with the rest. So on that
  day: **a renamed chunk, a `/mtgimg/…` miss, `/_headers` and a `curl`-style deep link are each
  a `429 text/html`** — not the document with a 200, and not the script's 404 either. **A file
  that exists and a browser's navigation are untouched**: `routeToAssets` is not behind the
  check, which is what not being `run_worker_first` buys — the app still loads and deep links
  still open on the day sync is down. (This paragraph read the billing sentence backwards for
  two commits and concluded a miss would fall back to the document. The source says otherwise.)
  ⚠️ **A `429 text/html` is still HTML where code was asked**: a page across a deploy on a spent
  day gets a failed import with a status, which is the failure the app reports — but nothing
  here has seen what a service worker makes of it.
- **Limits**: 20,000 files and 25 MiB a file per version on the free plan
  (`workers/platform/limits`); the module, the build's largest file, is a third of that.
  `_headers` allows 100 rules and 2,000 characters a line (same page); the file is well inside
  both, and `src/headers.ts` refuses one that is not.
- **No storage, no cron trigger, no secret.** This Worker adds nothing to the account's five
  triggers and nothing to D1's or R2's counters.

## The configuration, key by key

Each verified against Cloudflare's documentation on 2026-10-04.

| Key | Value | Where it is documented |
| --- | --- | --- |
| `main` | `src/index.ts` | `workers/static-assets/` — "If no matching asset is found and a Worker script is present, the request will be processed by the Worker" |
| `compatibility_date` | `2026-08-27`, the relay's | `workers/configuration/compatibility-flags/` — `assets_navigation_prefers_asset_serving` is the default from `2025-04-01` |
| `routes[].custom_domain` | `mtg-grimoire.app` | `workers/configuration/routing/custom-domains/` — the apex form is the page's own example; DNS and certificate are created by the deploy |
| `workers_dev`, `preview_urls` | `false`, `false` | `workers/versions-and-deployments/version-urls/` — "If `preview_urls` is omitted, Wrangler does not change an existing Version URL setting" |
| `assets.directory` | `../../apps/light/dist-web` | `workers/static-assets/binding/` |
| `assets.binding` | `ASSETS` | `workers/wrangler/configuration/` — "only useful when a Worker script is set with `main`" |
| `assets.not_found_handling` | `single-page-application` | `workers/static-assets/routing/single-page-application/` — with a script, "*navigation requests* will not invoke the Worker script" |
| `observability` | `{ "enabled": true }` | as the other two Workers |

`html_handling` is left at its default, `auto-trailing-slash`: `/index.html` redirects to `/`.
**One other HTML file is in the build since 2026-10-07: `privacy.html`**, the privacy policy
(`apps/light/public/`), which that default serves at `/privacy` and redirects `/privacy.html` to.
A reader the service worker controls never reaches the host for it, bar a cache miss or an
older worker that has not updated yet: the worker answers `/privacy` with the precached file (`sw/shell.ts`, `routeFor`).

## Testing

No workerd in this tree, for the reason `infrastructure/share-worker/README.md` gives. The script is a plain
function over an injected `Env`, driven as `worker.fetch(request, env)` against a fake of the
assets binding **that answers a missing path with the document, as the real one does** — so a
script that deferred a missing chunk to the binding fails there.

```
npx vitest run infrastructure/app-worker/
npx tsc -p infrastructure/app-worker/tsconfig.json
```

`infrastructure/app-worker/src/**/*.test.ts` is a glob in `vitest.config.ts`; a directory that list does not name
is collected by nothing. `scripts/ci-route.mjs` routes this directory to `frontend`, which runs
all of the above, and to `web`, whose build copies `_headers` and loads `src/headers.ts`.
