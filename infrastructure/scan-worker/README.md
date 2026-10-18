# `infrastructure/scan-worker/` — the scan inbox

A fourth Cloudflare Worker, beside the relay, the share Worker and the web app's hosting. It has
one route: the card scanner's **Send** posts one scan to it — the last couple of seconds of
frames the scanner was given, with the exact printing and finish a reader says they show — and
it keeps both so the scanner can be tested against them and improved (issue #776).

**Sending a scan is a supporter's** (the owner's decision, 2026-10-11). The app draws the press
only on a device whose sync group a membership covers, the engine refuses a send from any other
before it builds a request, and this Worker takes a scan only with the relay's token on it
(`src/auth.ts`) — the check the share Worker makes of a publish, with the same key. It answers
at **`https://scans.mtg-grimoire.app`**, a Custom Domain on the web app's zone, and nowhere
else.

**A scan is a run of frames, never one picture.** The scanner decides over a run — a lock that
settles, evidence that pools, a vote that crosses a bar — so one frame cannot say what it did.
What is sent is five to twenty of the frames it actually judged, byte for byte and in order,
each beside what it answered for it: put back through the scanner, that is the scan again. It
is all of them or nothing: **the app cannot send one picture, and this Worker refuses both
shapes one would arrive in** — a body sent as `image/jpeg`, and a label that lists fewer than
five frames (`src/label.test.ts` and `src/submit.test.ts`, *one picture is never a scan*). What
it holds a body to is its framing — as long as the label's frames together, a JPEG's first
bytes at each — and not its content: nothing here decodes a picture, so a request built by hand
can still dress one picture as five. The engine reads every frame's header before it sends.

**A reader sends one scan at a time, by hand.** The app shows every picture of the run first,
the reader picks the card and the finish, and only that press calls this Worker. Nothing here is
asked on a launch, on a schedule or on a frame.

## Why it is a Worker of its own

**Blast radius.** It binds the least there is: **one R2 bucket and one rate limiter. No D1, no
Durable Object, no service binding.** A fault here can fill or lose the scans; it cannot write a
membership, a sync log or a shared binder, and a deploy here cannot break any of them.

⚠️ **It does hold one secret, and it is the one that matters**: `RELAY_HMAC_KEY`, the key the
relay signs every sync token with, so that this Worker can tell a supporter's device from a
stranger (`src/auth.ts`). It was first built open to anybody and held nothing; the door cost it
that, and the key is on three Workers where it was on two. What this one does with it is
`verify` and nothing else. It imports that one module of the relay's (`wrangler.jsonc`'s
`alias`), mints nothing, returns no claim, stores none and keeps no log:
`src/wrangler.test.ts` holds that the key is read in `auth.ts` alone, and
`scripts/scan-worker-alias.test.ts` that the script a deploy uploads cannot reach `mint`.

**And nothing is ever read back out through it.** There is no `GET` for a run or a label, no
listing and no delete: the token says a device may send and nothing says a request is the
maker's, so no sender is offered either. An upload route that also served what it took would be
image hosting for whoever held a token. The maker reads the bucket with his own credentials (below).

## The route

| Route | Body | Answer |
| --- | --- | --- |
| `POST /scan`, with `authorization: Bearer <the relay's token>` | the run's frames end to end, as `application/octet-stream` | `201 { "id": "…" }` |
| `OPTIONS /scan` (a browser's pre-flight) | | `204`, for an origin on `APP_ORIGINS` |
| anything else | | `404`, or `405` on `/scan` |

**The token is the one the app syncs with** — minted by the relay for a device whose group a
membership covers, good for a day — and it is checked and thrown away: `verify` answers yes or
no, and no claim of it reaches the handler, the bucket, the limiter's key or a log.

**The body is the JPEGs one after another with nothing between them.** The label says how long
each is (`run[n].bytes`), which is the only framing there is — so what is stored is the
scanner's own bytes, and nothing here decodes, re-encodes or unwraps a picture.

The label rides in the `x-scan-label` header as **ASCII JSON** — every character past `~` escaped
as `\u….`, which is how the app already sends its scanner a frame's options. A header's bytes
reach a Worker as Latin-1, so a name sent as it is spelled would be stored as mojibake; a header
that is not ASCII is refused rather than repaired. A real one is some four thousand characters,
twenty frames' figures being most of it; the cap is 8192.

The refusals, in the order they are checked — each before anything that costs more:

| Status | `code` | When |
| --- | --- | --- |
| 405 | | not `POST` (ahead of the limiter) |
| 429 | `rate_limited` | more than 12 a minute from one address |
| 500 | `no_key` | this Worker holds no `RELAY_HMAC_KEY`: it was deployed and its secret never set (*Deploying*) |
| 401 | `unauthorized` | no bearer token, or one the relay's key does not verify — expired, another key's, edited, junk. One answer for all of them, and **ahead of everything about the scan**: a stranger's type, label and body are not read |
| 403 | `restricted_device` | a live token whose `cap` claim is present and not `full` — a device a group's signed roster restricts, the Discord bot (the integration's second PR, spec §12). Ahead of everything about the scan, as the 401 is |
| 415 | | not sent as `application/octet-stream` — **`image/jpeg`, one picture's type, among them** |
| 400 | | no label, or one `src/label.ts` refuses (the sentence names the field, and the frame) — **a `run` of fewer than five frames among them** |
| 413 | `run_limit` | over 2 MB by what the label's frames add up to, or by its `content-length` |
| 503 | `inbox_full` | the inbox was full when this isolate last asked, under a minute ago |
| 413 | `run_limit` | over 2 MB by the bytes as they arrive |
| 400 | | the body is not as long as the label's frames together, or does not start as a JPEG does at one of them |
| 503 | `inbox_full` | 500 runs already waiting |

The app words each of these for a reader itself (`crates/grimoire-core/src/scanner_submit.rs`),
matching on the status or the `code` and never on the sentence, which is written for a developer
with a `curl`. It also refuses a run that is too short, too long or too heavy before any request,
so the 400 and the 413 above are backstops a reader does not meet — and a device that is not a
supporter's before any request too, so a 401 is what a token that died in flight, or a key that
is not the relay's, looks like. It words a 401 or a 403 as *the server did not accept this
device* and **never as anything about a membership**: the Android build is Google Play's, and
may not lead a reader to one bought elsewhere.

## What is stored

Two objects a submission, under one id — `20261011T101500Z-9f8a…`, the second it arrived and
eight random bytes:

- `runs/{id}.bin` — the frames end to end, byte for byte as they were sent. Nothing is decoded
  or re-encoded.
- `labels/{id}.json` — the label, **rebuilt from the fields that were checked** (a key the shape
  does not name is dropped, at every depth), plus `id`, `received_at` (this Worker's clock) and
  `bytes` (the whole run's length).

```json
{
  "v": 1,
  "card": { "id": "<Scryfall id>", "set": "2x2", "number": "117", "lang": "en", "name": "Lightning Bolt" },
  "finish": "foil",
  "scanner": {
    "reported": "<Scryfall id or null>", "mode": "fast", "confidence": 0.82, "distance": 31, "bundle": 98000,
    "filters": { "sets": ["2x2", "lea"], "from": null, "to": "2022-07-08" }
  },
  "app": { "version": "0.43.0", "platform": "desktop" },
  "run": [
    { "ms": -220, "bytes": 51877, "width": 960, "height": 540, "ok": true, "lock": "acquiring", "confidence": null, "distance": 44, "decided": null, "detail": false },
    { "ms": -110, "bytes": 52102, "width": 960, "height": 540, "ok": true, "lock": "locked", "confidence": 0.413, "distance": 31, "decided": null, "detail": true },
    { "ms": 0, "bytes": 51990, "width": 960, "height": 540, "ok": true, "lock": "locked", "confidence": 0.82, "distance": 31, "decided": "<Scryfall id>", "detail": false }
  ],
  "id": "20261011T101500Z-9f8a0c1d2e3f4a5b",
  "received_at": "2026-10-11T10:15:00.123Z",
  "bytes": 155969
}
```

(Three frames shown; a real `run` has five to twenty.)

`card` is the printing the reader chose — **the card in the last frame**, the one under the
camera at the press; the engine reads its set, number, language and name out of the install's
own card data, so a label cannot pair one printing's id with another's name. `scanner` is what
the scanner had said at the press, and every figure is `null` when it had none. **`reported` is
the printing it had decided on, and `null` while it had decided nothing** — never the card it
was merely leaning towards, which the tracker knows by another id. So `reported === card.id` is
a scan it got right, any other id is one it got wrong, and `null` is one it had not answered;
`confidence` and `distance` are how far it had got. `filters` is what the reader had narrowed
the scanner to (set codes and a release-date range), which decides what it *could* have
answered: a run replayed without them is another scan.

`run` is **one entry a frame, oldest first, and the index of `runs/{id}.bin`**:

| Key | |
| --- | --- |
| `ms` | when the frame was taken, in milliseconds before the press — zero or negative, by the app's clock. The gaps between them are the scanner's real frame rate |
| `bytes` | the frame's length in the object; the next frame starts where this one ends |
| `width`, `height` | read by the engine from the JPEG's own header |
| `ok` | whether the scanner found a card in it at all |
| `lock` | the quad lock's phase on it (`idle`, `acquiring`, `locked`), or `null` |
| `confidence`, `distance` | the tracker's confidence after it and the best match's distance in bits, each `null` with none |
| `decided` | the printing the scanner had decided on by this frame, or `null` — the frame where this first appears is the one it made up its mind on |
| `detail` | a larger picture went to the scanner with this frame. **It is not in the run** — a replay of a `detail` frame gives the scanner less than it had |

**Nothing stored says who sent it**: no device, no group, no account, no address. The token
that opened the door names the first three, and none of it is kept — not in either object
(`src/auth.test.ts`, *leaves nothing of its token in what is stored*) and, with observability
off, not in a log. The privacy
policy (`apps/light/public/privacy.html`, *Sending a scan*) promises that, so a field added to
the label is a sentence owed there — and `id` is the only way one submission is found again,
which is why the app shows it to the reader.

**The run is written first and the label last**, and both writes are handed to the runtime to
finish (`waitUntil`) so a sender who hangs up between them does not split a pair. A write that
fails in between still leaves a run nobody named, which is litter: a `runs/` object with no
`labels/` object of the same id is a failed upload and can be deleted. It is counted against the
cap all the same — see below.

## What bounds it

- **A supporter's token** (`src/auth.ts`). Who can store a byte here is the devices a
  membership covers, and whoever holds a leaked token for the day it lives. Everything below is
  what bounds *them*.
- **500 runs waiting** (`MAX_PENDING`), counted by listing `runs/` — one list a submission, no
  counter to drift. With the 2 MB cap that is **about a gigabyte**, against R2's free ten,
  whoever is sending and from however many addresses. A full inbox turns scans away with a
  sentence until it is emptied; that is the right way round — a full inbox costs a few scans, an
  unbounded one costs money.
  - **It counts runs, not labels**, so a run whose label never landed is counted: bytes are what
    the cap is for, and a sender who could make uncounted ones would not be bounded.
  - **It is asked after the run has arrived, not before.** Asked first, a sender who sent its
    headers and held its body back was counted in before it stored anything, and any number of
    them could be let past a nearly full inbox at once.
  - **"About", because the count and the write are two steps.** Requests that count in the same
    instant each store, so the inbox can end a burst holding 500 and that burst. Nothing here
    can make the two one step — that takes a Durable Object or a database, which this Worker
    is deliberately without — and the next request after the burst is refused.
  - **A full inbox is remembered for a minute** by the isolate that found it full, so a flood
    against one costs a refusal and not a list each. A list is a billed R2 operation (the free
    plan gives a million a month, shared with the share Worker); a submission that is stored
    costs three.
- **2 MB a run** (`MAX_RUN_BYTES`), every frame together, which the engine refuses first. The
  app sends the frames its scanner was given — JPEGs some 960 pixels on their long edge — and
  keeps a run under a megabyte and a half.
- **Five to twenty frames a run** (`MIN_RUN_FRAMES`, `MAX_RUN_FRAMES`): about half a second to
  about two. The floor is the rule above — one picture is not a scan.
- **12 a minute from one address** (`RL_SUBMIT`). Measured on the relay, these limiters are far
  looser than their number reads: it bounds a flood from one address and nothing else, and it
  fails open when the binding is missing or throws.
- **A strict label.** A submission without a whole one is refused, not stored.

It does not keep a request off the account's 100,000-a-day budget: the Worker has already been
invoked to refuse it. A rule in front of the Worker is possible now that it is on the zone, and
none is set.

## A browser

The web app's engine sends from a page with `fetch`, so `src/cors.ts` answers the pre-flight and
puts `Access-Control-Allow-Origin` on every answer — the refusals above all — for an origin on
`APP_ORIGINS`, which is exactly `https://mtg-grimoire.app`. It is the relay's `cors.ts`, copied,
and it is **not an access control** here either — `src/auth.ts` is, and `curl` sends whatever
`Origin` it likes. What it buys is that a foreign page cannot have a reader's browser ask this
Worker and read what it answers. The pre-flight is told it may send `authorization`,
`content-type` and `x-scan-label` — the three headers the engine sets — and is itself answered
ahead of the door, since a browser sends it with no token. The web
policy's `connect-src` names this Worker's host (`infrastructure/app-worker/_headers`), so **this
Worker is deployed before a web build that asks it**: a page that asks a host with no CORS answer
fails every request.

## Reading the inbox

With the owner's own credentials — never through this Worker.

**The usual way is `pnpm scanner:corpus pull`** (`scripts/scanner-corpus.ts`). It copies each
complete pair from this bucket to the private corpus bucket `mtg-grimoire-scan-corpus` — but only
once the label parses, its frames' `bytes` add up to the run and each frame is a JPEG; a pair that
does not is left here untouched and reported as "do not add up" — reads each copy back by size,
and mirrors that bucket to `.scanner-corpus/` in the main checkout with every run cut into
`frames/<id>/NN.jpg`. **`--drain` then deletes from this bucket every complete pair whose copy in
the corpus has the same two sizes**, whether this pull or an earlier one copied it, and nothing
else: it is the one step that deletes, and the owner's to run. A read scan lives in the corpus bucket after, and
`pnpm scanner:replay` replays the mirror (`docs/reference/card-scanner.md` §10, *The replay*).
The credentials are `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, from the
environment only. **A deletion request names an id**, and `pnpm scanner:corpus remove <id>...`
(or `--from-file <path>`, one id a line) honours it. Without `--yes` it is a dry run: it lists
where each id is — the inbox, the corpus, the local mirror — and how many rows it has in each local
baseline, and deletes nothing; an id found nowhere is said so and makes the exit code 1. With
`--yes` it deletes, id by id, the inbox's label and then its run, the corpus's label and then its
run (the inbox first, so the next pull cannot copy the scan back; the label first, so a
half-deleted scan is litter, never a label with no run), then the local pair (whichever of its
four paths is there, so a half-removed one is finished), and after every id the last report and
the baselines: the ids' rows go from every baseline, found or not, here and in the corpus bucket
(an id held only by a baseline is not a failure). That is the pull's whole baseline sync, so it
also downloads baselines the corpus has and this machine lacks and uploads those only here and
any an earlier upload left pending. Only those exact objects, and only those that are listed: a
half pair or a lone run is removable this way, which is the point. A step that fails ends that
id, is listed at the end and makes the exit code 1; run it again to finish. **Only the owner runs it with `--yes`** — an agent runs the dry run and shows the
owner the list. The hand-run way works too: delete both objects in both buckets
(`npx wrangler r2 object delete mtg-grimoire-scans/labels/<id>.json --remote`, then
`runs/<id>.bin`, then the same two in `mtg-grimoire-scan-corpus`; the inbox first, or an undrained
inbox would copy it again), and `pnpm scanner:corpus pull` removes it locally — its frames, its
slices, the last report and its rows in every baseline, here and in the corpus bucket. Every pull
reconciles the baselines against the corpus, and retries an upload that failed on the one before.
A full, deliberate purge of the corpus is refused locally until the mirror folder is removed by
hand, because an empty listing is also what an unreadable bucket looks like (`remove` names what
it deletes, so that refusal does not stop it).

**By hand**, when the tool is not at hand:

```
npx wrangler r2 object get mtg-grimoire-scans/labels/<id>.json --remote --file <id>.json
npx wrangler r2 object get mtg-grimoire-scans/runs/<id>.bin --remote --file <id>.bin
```

**Cutting a run back into its frames** is one walk of the label — `<id>/00.jpg` is the oldest:

```js
// node split.mjs <id>   (beside <id>.json and <id>.bin)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const id = process.argv[2];
const { run } = JSON.parse(readFileSync(`${id}.json`, "utf8"));
const bytes = readFileSync(`${id}.bin`);
mkdirSync(id, { recursive: true });
let at = 0;
for (const [n, frame] of run.entries()) {
  writeFileSync(`${id}/${String(n).padStart(2, "0")}.jpg`, bytes.subarray(at, at + frame.bytes));
  at += frame.bytes;
}
```

Fed to the scanner in that order, `ms` apart, with `scanner.mode` and `scanner.filters` set as
the label says, the frames are the scan as the scanner saw it — short of whatever came before
the run's first frame, and of the larger picture a `detail` frame had beside it.

For the whole inbox, R2's S3 API with an API token scoped to this one bucket (`rclone copy`, or
`aws s3 sync` against the account's R2 endpoint) brings `runs/` and `labels/` down as two
folders that pair by file name. **Delete what has been read** — the cap counts what is waiting,
and an inbox nobody empties stops taking scans at 500. A deletion request names an id; delete
both of its objects, in the bucket and in any copy.

## Deploying

**A release deploys this Worker** (`release.yml`'s `scan-deploy`; the owner's decision,
2026-10-11). Merging the release PR puts this folder's script on its address, behind the share
Worker and **ahead of the web app** — the page's policy names this host, and its Send waits on
this Worker's CORS answer — with the relay's deploy token (`CLOUDFLARE_INFRA_API_TOKEN`, in the
`release` environment), and then asks the live address the probes below. Without that token the
job deploys nothing, says so in the run's summary and ends green.

**Deployed, and asked, on 2026-10-11** — by hand, by the owner, with the secret set after it.
At 18:03 UTC `node scripts/scan-deploy-probe.ts` was answered seven of seven on its first
asking, twice (the owner's terminal, then an agent's): the route is at
`scans.mtg-grimoire.app`; a `POST` with `authorization: Bearer nonsense` is
`{"error":"unauthorized","code":"unauthorized"}`, 401 and not 500, so the Worker holds a key;
and `https://mtg-grimoire-scans.denmark-east.workers.dev/scan` answers 404 — there is no
second address. **What that leaves unseen is what no probe holds a token for**: that the key
is the relay's, and that the bucket takes a write. Nobody has sent a scan, and no release has
run the job.

⚠️ **No agent may run `wrangler deploy` or create the bucket unasked.** Between releases a
deploy is by hand and asked for, each time, as for every Worker. `wrangler dev --local` is the
only wrangler command an agent may run on its own.

**What only the owner does, once** — three things, and the order of the last two matters.

1. **Create the bucket.**

   ```
   npx wrangler r2 bucket create mtg-grimoire-scans --location weur
   ```

   The deploy fails naming the `SCANS` binding until the bucket exists — and in a release that
   stops the web app's deploy too, which waits for this one. (Created 2026-10-11, by the
   owner's word.)

2. **Let the deploy token state a Custom Domain**: `CLOUDFLARE_INFRA_API_TOKEN` needs *Zone →
   Workers Routes → Edit* on `mtg-grimoire.app`, as the relay's and the share Worker's own
   Custom Domains do (added 2026-10-11, by the owner's word —
   `docs/reference/ci-and-releases.md`, *What only the owner can do*). With it the deploy
   states `scans.mtg-grimoire.app`'s DNS record and certificate itself. A deploy by hand uses
   the owner's own login, which has it. (This Worker was added to the token's permissions on
   2026-10-11 as well, by the owner's word; the first release to run `scan-deploy` is what
   shows it reaches.)

3. **Set the one secret, after the first deploy** — from this folder, in a terminal of the
   owner's own, never an agent's:

   ```
   node ../wrangler/node_modules/wrangler/bin/wrangler.js secret put RELAY_HMAC_KEY
   ```

   with the **same value** the relay and the share Worker hold. ⚠️ **After, not before**: on
   the share Worker a `secret put` against a Worker that did not exist yet did not stick
   (`infrastructure/share-worker/README.md`, *Deploying*). ⚠️ **Cloudflare never shows a
   secret back**, so the value comes from wherever the owner kept it. If it was not kept, the
   way out is a new key put on all three Workers in one sitting — which ends every token
   already minted, so each device is refused once and asks the relay for a new one. A deploy
   neither reads nor changes the secret: it is set once.

   **Until it is set the Worker answers every `POST /scan` with 500, `no_key`**, and the probe
   below fails saying so by name. ⚠️ **In a release that leaves the release a draft and the web
   app undeployed** — `web-deploy` and `publish` wait for `scan-deploy`. So the first deploy
   is the one to make **by hand** (below), with the secret straight after it, before the
   release that carries Send. If a release gets there first, set the secret and re-run that
   run's failed jobs.

There is no schema to apply. Before the Android release that carries Send, the Play Console's
Data safety form changes — `docs/play/README.md`, *Data safety*.

**For the corpus** — two things more, once, for reading scans rather than for taking them:

1. **Create the corpus bucket.**

   ```
   npx wrangler r2 bucket create mtg-grimoire-scan-corpus --location weur
   ```

   No Worker is bound to it; only `pnpm scanner:corpus` reads and writes it.

2. **Make an R2 API token** with object read and write on this bucket and the corpus bucket, and
   set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the terminal that runs
   the tool. The token is never written to a file and never an agent's to hold.

**By hand** — a first deploy that should not wait for a release, or one between releases —
from this folder, with the pinned tool:

```
npm ci --ignore-scripts --prefix ../wrangler
node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy
```

Read what it prints: the route `scans.mtg-grimoire.app (custom domain)`, and no `workers.dev`
address. `https://scans.mtg-grimoire.app` is `scanner_submit::SCAN_BASE` in the engine, a
source in the web policy and a row of the privacy policy; `src/wrangler.test.ts` holds the
route's pattern to the engine's line. Then step 3 above: the secret.

**Ask the host, rather than this file, what it does.** The release's own probe holds no token
and stores nothing; from the repository's root:

```
node scripts/scan-deploy-probe.ts
```

Its seven requests, and what a deployed Worker answers:

| Request | Answer |
| --- | --- |
| `GET /scan` | `405`, `method not allowed` |
| `POST /scan` with no token | `401`, `unauthorized` — the door is shut |
| `POST /scan` with `authorization: Bearer nonsense` | `401`, `unauthorized` — the door holds a key. ⚠️ **`500` here, and on the request above, is the secret's tell: `RELAY_HMAC_KEY` is not set** |
| `OPTIONS /scan` from `https://mtg-grimoire.app` | `204`, with that origin allowed |
| `POST /scan` from `https://mtg-grimoire.app`, with no token | `401`, and readable by the page: the origin allowed |
| `OPTIONS /scan` from another origin | `405`, with no origin allowed |
| `GET /runs/x.bin` | `404`, `not found` — nothing is served back |

`scripts/scan-deploy-probe.test.ts` asks the same seven of this tree's code, over a bucket that
throws if it is touched. **None of them stores anything and none holds a token**, so two things
are shown only by a real scan: that the bucket's binding takes a write, and that **this
Worker's key is the relay's** — a wrong key refuses nonsense exactly as the right one does, and
then answers every supporter's Send with *the server did not accept this device*. Send one scan
from a supporter's device and read it back out of the bucket (*Reading the inbox*, above).

**Until a Worker is deployed** the name does not resolve, so a supporter's press on Send is
answered in a sentence — *the server could not be reached* — and nothing else in the app
notices.

## Testing

No workerd in this tree, for the reason `infrastructure/share-worker/README.md` gives: the
handler is a plain function over an injected `Env`, driven as `worker.fetch(request, env)` over
`src/fake.ts`'s bucket and limiter.

```
pnpm exec vitest run --project scan-worker
pnpm exec tsc -p infrastructure/scan-worker/tsconfig.json
```

`auth.test.ts` is the door, and every refusal in it is asserted over a bucket that throws.
`fake.ts` mints the suite's tokens with the relay's own `mint` and a key of its own, and sends
one by default — so every request the other suites make is a supporter's, and each is about
what it says it is about.

`label.test.ts` and `wrangler.test.ts` read the engine's Rust, this folder's `wrangler.jsonc` and
the privacy policy as text: a label field the engine sends and this side does not read, an
address or a bound that moved on one side only, and a log switched back on are each red there.
